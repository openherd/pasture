import process from "node:process";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { ping } from "@libp2p/ping";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { identify, identifyPush } from "@libp2p/identify";
import { multiaddr } from '@multiformats/multiaddr'
import { webSockets } from "@libp2p/websockets";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { autoNAT } from "@libp2p/autonat";
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import nunjucks from "nunjucks";
import utils from "./utils.js";
import prettydate from "pretty-date";
import bodyParser from "body-parser";
import schemas from "./schemas.js";
import {
  newPost,
  processChunk,
  getPost,
  chunkMessage,
  rankPosts,
  postOK,
} from "./utils.js";
import cookieParser from "cookie-parser";
import geolib from "geolib";
import geoIp2 from "geoip-lite2";
import config from "./config.json" with { type: "json" };
const app = express();
var messageBuffer = {};

app.use(cookieParser());
app.set("trust proxy", (ip) => {
  if (ip === "127.0.0.1" || ip === "::1") return true;
  else return false;
});
async function getReplies(postId) {
  let replies = await getPost(postId);

  for (let reply of replies) {
    reply.replies = await getReplies(reply.id);
  }

  return replies;
}

(async () => {
  const publicIp = process.env.PUBLIC_IP || (await (await fetch('https://api.ipify.org?format=json')).json()).ip
  const node = await createLibp2p({
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${process.env.REGULAR_PORT}`,
        `/ip4/0.0.0.0/tcp/${process.env.WS_PORT}/ws`,
      ],
      announce: [
        `/ip4/${publicIp}/tcp/${process.env.REGULAR_PORT}`,
        `/ip4/${publicIp}/tcp/${process.env.WS_PORT}/ws`,
        `/dns4/${process.env.DNS_HOSTNAME}/dns4/${process.env.WS_PORT}/wss`
      ]
    },
    transports: [webSockets(), tcp()],
    connectionEncrypters: [noise()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    services: {
      ping: ping({
        protocolPrefix: "ipfs",
      }),
      identify: identify(),
      identifyPush: identifyPush(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        maxInboundDataLength: 1024 * 8,
        enabled: true,
        globalSignaturePolicy: "StrictSign",
      }),
      autoNat: autoNAT(),
      relay: circuitRelayServer(),
    },
    streamMuxers: [
      yamux({
        enableKeepAlive: true,
        maxInboundStreams: 100,
        maxOutboundStreams: 100,
      }),
    ],
  });
  await node.start();
  console.log("libp2p has started");
  console.log("listening on addresses:");
  node.getMultiaddrs().forEach((addr) => {
    console.log(addr.toString());
  });

  function discover() {
    config.bootstrappingServers.map(async server => {
      try {
        const listeners = await (await fetch(`${server}/api/listeners`)).json()
        const wsConnections = [];
        const tcpConnections = [];

        listeners.forEach(multiaddr => {
          if (multiaddr.includes('/ws')) {
            wsConnections.push(multiaddr);
          } else {
            tcpConnections.push(multiaddr);
          }
        });
        const peerAddresses = [...wsConnections, ...tcpConnections];
        for (const l of peerAddresses) {
          try {
            await node.dial(multiaddr(l));
            break;
          } catch (e) {
          }
        }
      } catch (e) {
        console.error(e)
      }
      try {
        const discovery = await (await fetch(`${server}/api/discovery`)).json()
        const wsConnections = [];
        const tcpConnections = [];

        discovery.forEach(multiaddr => {
          if (multiaddr.includes('/ws')) {
            wsConnections.push(multiaddr);
          } else {
            tcpConnections.push(multiaddr);
          }
        });
        const peerAddresses = [...wsConnections, ...tcpConnections];
        for (const l of peerAddresses) {
          try {
            await node.dial(multiaddr(l));
          } catch (e) {
          }
        }
      } catch (e) {
        console.error(e)
      }
    })
  }
  const catchUp = async () => {
    let peers = node.services.pubsub
    if (!peers) return;
    const chunks = chunkMessage(JSON.stringify({}));
    await Promise.all(chunks.map(async (chunk, index) => {
      const packet = { index, total: chunks.length, content: chunk };
      const readyToSend = new TextEncoder().encode(JSON.stringify(packet));
      const a = await node.services.pubsub.publish("catchup", readyToSend);
    }));
  };
  await discover()
  await catchUp()
  setInterval(discover, 1000 * 30)
  setInterval(catchUp, 1000 * 1)
  node.services.pubsub.addEventListener("message", async (message) => {
    const sender = message.detail.from;
    var data = new TextDecoder().decode(message.detail.data);
    if (!["posts", "catchup", "backlog"].includes(message.detail.topic)) return;
    const processed = processChunk(sender, data, messageBuffer, node);
    if (!processed) return; // Will return undefined until it's finished.
    if (message.detail.topic == "posts") {
      utils.importPost({
        ...JSON.parse(processed),
        node,
        from: message.detail.from,
        raw: processed,
      });
    } else if (message.detail.topic == "catchup") {
      if (!schemas.catchUp.safeParse(JSON.parse(processed)).success) {
        await node.hangUp(message.detail.from);
      }
      var backfeed = await utils.catchUp({
        max: JSON.parse(processed).max,
        node,
      });
      var packet = JSON.stringify(backfeed);
      const chunks = chunkMessage(packet);
      await Promise.all(
        chunks.map(async (chunk, index) => {
          await node.services.pubsub.publish(
            "backlog",
            new TextEncoder().encode(
              JSON.stringify({
                index,
                total: chunks.length,
                content: chunk,
              }),
            ),
          );
        }),
      );
    }
  });
  node.services.pubsub.subscribe("browser-peer-discovery");
  node.services.pubsub.subscribe("posts");
  node.services.pubsub.subscribe("catchup");
  node.services.pubsub.subscribe("backlog");

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    next();
  });
  app.use(express.static("public"));
  app.use(bodyParser.urlencoded({ extended: true }));

  const env = nunjucks.configure("views", {
    autoescape: true,
    express: app,
    noCache: true,
  });
  env.addFilter("getLocaleDate", function (a, date) {
    return new Date(date).toLocaleString("en-US", {
      timeZone: "America/New_York",
      timeStyle: "short",
      dateStyle: "long",
    });
  });
  env.addFilter("getPrettyDate", function (a, date) {
    return prettydate.format(new Date(date || ""));
  });
  app.get("/global", async (req, res) => {
    var { lat, lon } = req.cookies;
    var notice = null;
    if (
      (!lat || !lon) &&
      !req.ip.includes("127.0.0.1") &&
      !req.ip.includes("::1")
    ) {
      var geoloc = geoIp2.lookup(req.ip);
      if (geoloc) {
        notice = `<b>N.B.</b> Your location (${geoloc.city}) was inferred using your IP address. We did not send your IP to any external service; instead, it was determined locally.`;
        lat = geoloc.ll[0];
        lon = geoloc.ll[1];
      } else {
        lat = 0;
        lon = 0;
      }
    } else if (!lat || !lon) {
      lat = 0;
      lon = 0;
    }
    var posts = await utils.getPosts();
    posts = posts.map((post) => {
      const distance = geolib.getDistance(
        { latitude: post.latitude, longitude: post.longitude },
        { latitude: lat, longitude: lon },
      );
      post.km = geolib.convertDistance(distance, "km").toFixed(2);
      post.mi = geolib.convertDistance(distance, "mi").toFixed(2);
      return post;
    });
    posts = posts.filter((post) => !post.parent);
    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Sort posts by date

    res.render("global.njk", {
      posts,
      lat,
      lon,
      notice,
      peers: (await node.peerStore.all()).length,
      env: process.env,
    });
  });
  app.get("/", async (req, res) => {
    var { lat, lon } = req.cookies;
    var notice = null;
    if (
      (!lat || !lon) &&
      !req.ip.includes("127.0.0.1") &&
      !req.ip.includes("::1")
    ) {
      var geoloc = geoIp2.lookup(req.ip);
      if (geoloc) {
        notice = `<b>N.B.</b> Your location (${geoloc.city}) was inferred using your IP address. We did not send your IP to any external service; instead, it was determined locally.`;
        lat = geoloc.ll[0];
        lon = geoloc.ll[1];
      } else {
        lat = 0;
        lon = 0;
      }
    } else if (!lat || !lon) {
      lat = 0;
      lon = 0;
    }
    var posts = await utils.getPosts();
    posts = posts.map((post) => {
      const distance = geolib.getDistance(
        { latitude: post.latitude, longitude: post.longitude },
        { latitude: lat, longitude: lon },
      );
      post.km = geolib.convertDistance(distance, "km").toFixed(2);
      post.mi = geolib.convertDistance(distance, "mi").toFixed(2);
      return post;
    });
    posts = posts.filter((post) => !post.parent);
    posts = rankPosts(posts, lat, lon).toReversed();
    res.render("index.njk", {
      posts,
      lat,
      lon,
      notice,
      peers: (await node.peerStore.all()).length,
      env: process.env,
    });
  });
  setInterval(async function () {
    await node.services.pubsub.publish(
      "ping",
      new TextEncoder().encode(
        "pong"
      ),
    );
  }, 30 * 1000)
  app.get("/new", async (req, res) => {
    res.render("new.njk", { peers: (await node.peerStore.all()).length });
  });
  app.get("/post/:id", async (req, res) => {
    const { id } = req.params;
    const post = await getPost(id);
    if (!post) return res.render("404.njk");
    res.render("post.njk", {
      post,
      peers: (await node.peerStore.all()).length,
    });
  });
  app.get("/api/discovery", async (req, res) => {
    const connections = node.getConnections();
    const peerAddresses = connections.map(conn => {
      const peerId = conn.remotePeer.toString();
      const multiaddr = conn.remoteAddr.toString();
      return `${multiaddr}/p2p/${peerId}`;
    });
    res.json(peerAddresses);
  });
  app.get("/connect", async (req, res) => {
    res.render("connect.njk", {
      peers: (await node.peerStore.all()).length,
      id: node.getMultiaddrs().join("\n").trim(),
    });
  });
  app.post("/request-peering", async (req, res) => {
    const { id } = req.body;
    if (!id) res.send("Give an address");
    try {
      await node.dial(multiaddr(id));
    } catch (e) {
      console.error(e)
      return res.send("Failed to dial");
    }
    return res.send("Dial complete.");
  });
  app.post("/new", async (req, res) => {
    const { text } = req.body;
    const { lat, lon } = req.cookies;
    if (!lat || !lon)
      return res.send("You'll need to enable cookies.").status(400);
    if (process.env.MODERATE_POSTS) {
      const ok = await postOK(text);
      if (!ok)
        return res
          .send("Sorry, your post was caught in the moderation filters.")
          .status(400);
    }
    const packet = await newPost({ latitude: lat, longitude: lon, text, node });
    const chunks = chunkMessage(packet);
    await Promise.all(
      chunks.map(async (chunk, index) => {
        await node.services.pubsub.publish(
          "posts",
          new TextEncoder().encode(
            JSON.stringify({
              index,
              total: chunks.length,
              content: chunk,
            }),
          ),
        );
      }),
    );
    res.redirect(`/post/${JSON.parse(packet).id}`);
  });
  const listener = app.listen(process.env.PORT || 3000, () => {
    console.log(`Pasture listening on port ${listener.address().port}`);
  });
})();
