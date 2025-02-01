import process from 'node:process'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { multiaddr } from 'multiaddr'
import { ping } from '@libp2p/ping'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { identify, identifyPush } from '@libp2p/identify'
import { peerList } from '@libp2p/peer-list'
import { bootstrap } from '@libp2p/bootstrap'
import { readFileSync, writeFileSync } from 'node:fs'
require('dotenv').config()
const express = require('express')
const nunjucks = require("nunjucks")
const app = express()
const utils = require("./utils")
const prettydate = require("pretty-date");
const bodyParser = require('body-parser');
const schemas = require("./schemas")
const { newPost, processChunk, getPost, chunkMessage, rankPosts, postOK } = require("./utils")
const cookieParser = require('cookie-parser');
const geolib = require('geolib');
const geoIp2 = require('geoip-lite2');
const port = 3000;
var messageBuffer = {};

app.use(cookieParser());
app.set('trust proxy', (ip) => {
    if (ip === '127.0.0.1' || ip === '::1') return true
    else return false
});
async function getReplies(postId) {
    let replies = await getPost(postId);

    for (let reply of replies) {
        reply.replies = await getReplies(reply.id);
    }

    return replies;
}

(async () => {
    const node = await createLibp2p({
        addresses: {
            listen: ['/ip6/::1/tcp/0']
        },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        services: {
            ping: ping({
                protocolPrefix: 'ipfs',
            }),
            identify: identify(),
            identifyPush: identifyPush(),
            pubsub: gossipsub({
                allowPublishToZeroTopicPeers: true,
                maxInboundDataLength: 1024 * 8,
                enabled: true,
                globalSignaturePolicy: "StrictSign",
            })
        },
        streamMuxers: [yamux({
            enableKeepAlive: true,
            maxInboundStreams: 100,
            maxOutboundStreams: 100,
        })],
    })
    await node.start()
    console.log('libp2p has started')
    console.log('listening on addresses:')
    node.getMultiaddrs().forEach((addr) => {
        writeFileSync("cid", addr.toString())
        console.log(addr.toString())
    })
    node.services.pubsub.addEventListener('message', async (message) => {
        const sender = message.detail.from;
        const data = new TextDecoder().decode(message.detail.data);
        const processed = processChunk(sender, data, messageBuffer, node);
        if (!processed) return; // Will return undefined until it's finished.
        if (message.detail.topic == "posts") {
            if (!schemas.newPost.safeParse(processed).success) await node.hangUp(message.detail.from);
            utils.importPost({ ...JSON.parse(processed), node, from: message.detail.from });
        }
    });

    node.services.pubsub.subscribe('posts')

    app.use(express.static('public'))
    app.use(bodyParser.urlencoded({ extended: true }));

    const env = nunjucks.configure('views', {
        autoescape: true,
        express: app,
        noCache: true
    });
    env.addFilter('getLocaleDate', function (a, date) {
        return new Date(date).toLocaleString('en-US', { timeZone: 'America/New_York', timeStyle: "short", dateStyle: "long" })
    });
    env.addFilter('getPrettyDate', function (a, date) {
        return prettydate.format(new Date(date || ""))
    });
    app.get('/global', async (req, res) => {
        var { lat, lon } = req.cookies;
        var notice = null
        if (!lat || !lon) {
            var geoloc = geoIp2.lookup(req.ip)
            notice = `<b>N.B.</b> Your location (${geoloc.city}) was inferred using your IP address. We did not send your IP to any external service; instead, it was determined locally.`
            lat = geoloc?.ll[0]
            lon = geoloc?.ll[1]
        }
        var posts = await utils.getPosts()
        posts = posts.map(post => {
            const distance = geolib.getDistance(
                { latitude: post.latitude, longitude: post.longitude },
                { latitude: lat, longitude: lon }
            )
            post.km = geolib.convertDistance(distance, "km").toFixed(2)
            post.mi = geolib.convertDistance(distance, "mi").toFixed(2)
            return post
        })
        posts = posts.sort(function (a, b) {
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
        posts = posts.filter(post=>!post.parent)
        res.render("global.njk", { posts, lat, lon, notice, peers: node.peerStore.all().length, env: process.env })
    })
    app.get('/', async (req, res) => {
        var { lat, lon } = req.cookies;
        var notice = null
        if (!lat || !lon) {
            var geoloc = geoIp2.lookup(req.ip)
            notice = `<b>N.B.</b> Your location (${geoloc.city}) was inferred using your IP address. We did not send your IP to any external service; instead, it was determined locally.`
            lat = geoloc?.ll[0]
            lon = geoloc?.ll[1]
        }
        var posts = await utils.getPosts()
        posts = posts.map(post => {
            const distance = geolib.getDistance(
                { latitude: post.latitude, longitude: post.longitude },
                { latitude: lat, longitude: lon }
            )
            post.km = geolib.convertDistance(distance, "km").toFixed(2)
            post.mi = geolib.convertDistance(distance, "mi").toFixed(2)
            return post
        })
        posts = posts.filter(post=>!post.parent)
        posts = rankPosts(posts, lat, lon).toReversed()
        res.render("index.njk", { posts, lat, lon, notice, peers: (await node.peerStore.all()).length, env: process.env })
    })

    app.get('/new', async (req, res) => {
        res.render("new.njk", { peers: (await node.peerStore.all()).length })
    })
    app.get('/post/:id', async (req, res) => {
        const { id } = req.params;
        const post = await getPost(id)
        if (!post) return res.render("404.njk")
        res.render("post.njk", { post, peers: (await node.peerStore.all()).length })
    });
    app.get('/connect', async (req, res) => {
        res.render("connect.njk", { peers: (await node.peerStore.all()).length, id: node.getMultiaddrs()[0].toString() })
    });
    app.post('/request-peering', async (req, res) => {
        const { id } = req.body;
        if (!id) res.send("Give an address")
        try {
            await node.dial(id)
        } catch (e) {
            return res.send("Failed to dial")
        }
        return res.send("Dial complete.")

    });
    app.post('/new', async (req, res) => {
        const { text } = req.body;
        const { lat, lon } = req.cookies;
        if (!lat || !lon) return res.send("You'll need to enable cookies.").status(400)
        if (process.env.MODERATE_POSTS) {
            const ok = await postOK(text)
            if (!ok) return res.send("Sorry, your post was caught in the moderation filters.").status(400)
        }
        const packet = await newPost({ latitude: lat, longitude: lon, text, node })
        const chunks = chunkMessage(packet);
        await Promise.all(chunks.map(async (chunk, index) => {
            await node.services.pubsub.publish("posts", new TextEncoder().encode(JSON.stringify({
                index,
                total: chunks.length,
                content: chunk
            })));
        }));
        res.redirect(`/posts/${JSON.parse(packet).id}`)
    });
    app.listen(port, () => {
        console.log(`Example app listening on port ${port}`)
    })
})();