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
import { fuzzFromOverpass } from "./skew.js";
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
  checkModeration,
  updatePostModeration,
  getPostsFromLastTwoWeeks,
} from "./utils.js";
import cookieParser from "cookie-parser";
import geolib from "geolib";
import geoIp2 from "geoip-lite2";
import config from "./config.json" with { type: "json" };
const app = express();
var messageBuffer = {};
app.use(express.json())
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
        `/dns4/${process.env.DNS_HOSTNAME}/tcp/${process.env.WS_PORT}/wss`,
        `/ip4/${publicIp}/tcp/${process.env.REGULAR_PORT}`,
        `/ip4/${publicIp}/tcp/${process.env.WS_PORT}/ws`
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
    config.relayServers.map(async address => {
      try {
        const origin = new URL(address).origin;
        (await (await fetch(`${origin}/_openherd/outbox`)).json()).map(async post => {
          await utils.importPost({
            signature: post.signature,
            publicKey: post.publicKey,
            data: post.data,
            raw: JSON.stringify(post),
          })
        })
        await fetch(`${origin}/_openherd/inbox`, {
          method: "POST",
          body: JSON.stringify((await utils.catchUp({ max: 10000 })).map(m => JSON.parse(m)))
        })
        console.debug(`synced with ${address}`)
      } catch { }
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
  setInterval(catchUp, 1000 * 10)
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
    const short = str => str.replace(/^(\d+)\s(\w+).*$/, (_, n, unit) => n + unit[0]);
    return short(prettydate.format(new Date(date || "")));
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

    res.render("index.njk", {
      posts,
      lat,
      lon,
      title: "Global Posts",
      description: "The feed is sorted by date only.",
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
      title: "Local Posts",
      description: "These are posts sorted by your location and date, weighted equally in the ranking.",
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
    const wsdnsConnections = [];
    const wsConnections = [];
    const tcpConnections = [];

    connections.forEach(conn => {
      const multiaddr = conn.remoteAddr.toString();
      if (multiaddr.includes('/wss') && (multiaddr.includes('/dns4') || multiaddr.includes('/dns6'))) {
        wsdnsConnections.push(multiaddr);
      } else if (multiaddr.includes('/ws')) {
        wsConnections.push(multiaddr);
      } else {
        tcpConnections.push(multiaddr);
      }
    });

    const peerAddresses = [...wsdnsConnections, ...wsConnections, ...tcpConnections];
    res.json(peerAddresses);
  });
  app.get("/api/listeners", async (req, res) => {
    res.json(node.getMultiaddrs().map((addr) => {
      return addr.toString()
    }));
  });
  app.get("/settings", async (req, res) => {
    res.render("settings.njk", {
      peers: (await node.peerStore.all()).length,
      id: node.getMultiaddrs().join("\n").trim(),
    });
  });

  app.post("/settings", async (req, res) => {
    const { randomnessMode, units } = req.body;

    res.cookie('randomnessMode', randomnessMode, { maxAge: 365 * 24 * 60 * 60 * 1000 });
    res.cookie('units', units, { maxAge: 365 * 24 * 60 * 60 * 1000 });

    res.redirect('/settings?saved=true');
  });
  app.post("/api/skew-location", async (req, res) => {
    const { latitude, longitude } = req.body;
    const { randomnessMode, units } = req.cookies;

    if (!latitude || !longitude) {
      return res.status(400).json({ error: "Latitude and longitude are required" });
    }

    try {
      const settings = {
        mode: randomnessMode || 'privacy'
      };

      const result = await fuzzFromOverpass(parseFloat(latitude), parseFloat(longitude), settings);

      res.json({
        latitude: result.latitude,
        longitude: result.longitude,
        settings: result.settingsApplied,
        context: result.contextUsed
      });
    } catch (error) {
      console.error('Error skewing location:', error);
      res.status(500).json({ error: "Failed to skew location" });
    }
  });

  app.post("/_openherd/sync", async (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).send({ ok: false, error: "You must specify an address" });
    try {
      const origin = new URL(address).origin;
      (await (await fetch(`${origin}/_openherd/outbox`)).json()).map(async post => {
        await utils.importPost({
          signature: post.signature,
          publicKey: post.publicKey,
          data: post.data,
          raw: JSON.stringify(post),
        })
      })
      await fetch(`${origin}/_openherd/inbox`, {
        method: "POST",
        body: JSON.stringify((await utils.catchUp({ max: 10000 })).map(m => JSON.parse(m)))
      })
      return res.json({ ok: true, message: "Sync complete" })
    } catch {

    }
    try {
      await node.dial(multiaddr(address));
    } catch (e) {
      return res.status(500).send({ ok: false, error: "Failed to dial multiaddr" });
    }
    return res.send({ ok: true, message: "Multiaddr dial complete" });
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
  app.get("/_openherd/outbox", async (req, res) => {
    const { max } = req.query
    if (max && typeof max != "number") return []
    const posts = (await utils.catchUp({ max })).map(m => JSON.parse(m))
    res.json(posts)
  });
  app.post("/_openherd/inbox", async (req, res) => {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Expected an array of posts" });
    }
    try {
      for (var post of req.body) {
        if (typeof post == "string") post = JSON.parse(post)
        utils.importPost({
          ...post,
          raw: JSON.stringify(post)

        });
        const packet = JSON.stringify(post);
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
      }
      res.json({ ok: true, count: req.body.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: "Failed to send posts" });
    }
  });

  // Moderation endpoints
  app.get("/_openherd/labels", async (req, res) => {
    // Return available moderation labels
    const labels = [
      {
        "label": "Spam",
        "description": "Unwanted or repetitive content"
      },
      {
        "label": "Harassment",
        "description": "Content that targets individuals with abuse"
      },
      {
        "label": "Violence",
        "description": "Content promoting or depicting violence"
      },
      {
        "label": "Adult Content",
        "description": "Sexually explicit or suggestive content"
      },
      {
        "label": "Misinformation",
        "description": "False or misleading information"
      }
    ];
    res.json(labels);
  });

  app.post("/_openherd/labels/query", async (req, res) => {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Expected an array of post envelopes" });
    }

    try {
      const results = await checkModeration(req.body, config.moderationServices);
      res.json(results);
    } catch (error) {
      console.error('Error checking moderation:', error);
      res.status(500).json({ error: "Failed to check moderation" });
    }
  });

  app.post("/_openherd/labels/report", async (req, res) => {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Expected an array of post reports" });
    }

    try {
      // For now, just log the reports
      // In a real implementation, you'd store these in a database
      console.log('Received reports:', req.body.length);
      req.body.forEach((report, index) => {
        console.log(`Report ${index + 1}: ${report.reason} for post ${report.id}`);
      });

      res.json({
        ok: true,
        message: "Reports received",
        error: null,
        count: req.body.length
      });
    } catch (error) {
      console.error('Error processing reports:', error);
      res.status(500).json({
        ok: false,
        message: "Failed to process reports",
        error: error.message,
        count: 0
      });
    }
  });

  const listener = app.listen(process.env.PORT || 3000, () => {
    console.log(`Pasture listening on port ${listener.address().port}`);
  });
})();
