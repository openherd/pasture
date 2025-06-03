import { PrismaClient } from "@prisma/client";
import * as openpgp from "openpgp";
import * as tf from "@tensorflow/tfjs-node";
import * as toxicity from "@tensorflow-models/toxicity";
import * as geolib from "geolib";

const prisma = new PrismaClient();

export async function getPosts(parent) {
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  const posts = await prisma.post.findMany({
    where: {
      createdAt: {
        gte: twoWeeksAgo,
      },
      parent,
    },
  });

  return posts;
}
export async function catchUp({ max }) {
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  var posts = await prisma.post.findMany({
    where: {
      createdAt: {
        gte: twoWeeksAgo,
      },
    },
  });
  if (max)
    return posts
      .map((post) => {
        return post.raw;
      })
      .reverse()
      .slice(-max);
  else
    return posts.map((post) => {
      return post.raw;
    });
}

export async function importPost({
  signature,
  publicKey,
  data,
  raw,
}) {
  const key = await openpgp.readKey({
    armoredKey: publicKey,
  });
  const signedMessage = await openpgp.createMessage({
    text: data,
  });
  const signatureObject = await openpgp.readSignature({
    armoredSignature: signature,
  });
  const verificationResult = await openpgp.verify({
    message: signedMessage,
    signature: signatureObject,
    verificationKeys: key,
  });
  const { verified } = verificationResult.signatures[0];

  try {
    await verified; // throws on invalid signature
    const json = JSON.parse(data);
    if (process.env.MODERATE_POSTS) {
      const ok = await postOK(json.text);
      if (!ok) return;
    }
    const existingPost = await prisma.post.findFirst({
      where: {
        id: key.getFingerprint(),
      },
    });
    if (!existingPost) {
      await prisma.post.create({
        data: {
          id: key.getFingerprint(),
          createdAt: new Date(json.date),
          text: json.text,
          parent: json.parent,
          latitude: json.latitude.toString(),
          longitude: json.longitude.toString(),
          publicKey: publicKey,
          signature: signature,
          raw,
        },
      });
    }
  } catch (e) {
    console.error("Signature verification failed:", e);
  }
  return null;
}

export async function getPost(id) {
  return await prisma.post.findFirst({
    where: {
      id,
    },
  });
}

export async function newPost({ latitude, longitude, text, parent, node }) {
  const postDate = new Date();

  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "rsa",
    rsaBits: 4096,
    userIDs: [{ name: "Anon", email: "anon@example.com" }],
    passphrase: "post",
  });
  const key = await openpgp.readKey({ armoredKey: privateKey });

  const textToSign = JSON.stringify({
    id: key.getFingerprint(),
    text,
    latitude,
    date: postDate.toISOString(),
    longitude,
  });
  const message = await openpgp.createMessage({ text: textToSign });

  const privateKeyObj = await openpgp.readPrivateKey({
    armoredKey: privateKey,
  });
  const decryptedPrivateKey = await openpgp.decryptKey({
    privateKey: privateKeyObj,
    passphrase: "post",
  });

  const signature = await openpgp.sign({
    message: message,
    signingKeys: decryptedPrivateKey,
    detached: true,
  });
  var packet = JSON.stringify({
    signature: signature,
    publicKey,
    id: key.getFingerprint(),
    data: textToSign,
  });
  await prisma.post.create({
    data: {
      id: key.getFingerprint(),
      text,
      latitude,
      longitude,
      privateKey,
      publicKey,
      signature,
      raw: packet,
    },
  });
  return packet;
}

export function chunkMessage(message) {
  const MAX_CHUNK_SIZE = 500;
  const chunks = [];
  for (let i = 0; i < message.length; i += MAX_CHUNK_SIZE) {
    chunks.push(message.slice(i, i + MAX_CHUNK_SIZE));
  }
  return chunks;
}

export function isBase64(str) {
  // Base64 should be a multiple of 4 and only contain valid characters
  return /^[A-Za-z0-9+/=]+$/.test(str) && str.length % 4 === 0;
}
export function rankPosts(posts, userLat, userLon) {
  const alpha = 0.3;
  const beta = 0.3;
  const now = Date.now();

  return posts
    .map((post) => {
      const distance = geolib.getDistance(
        {
          latitude: userLat,
          longitude: userLon,
        },
        {
          latitude: post.latitude,
          longitude: post.longitude,
        },
      );
      const hoursAgo = (now - new Date(post.date).getTime()) / 3600000;

      const score = Math.exp(-alpha * distance) * Math.exp(-beta * hoursAgo);

      return { ...post, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function processChunk(sender, data, messageBuffer, node) {
  if (!messageBuffer[sender]) messageBuffer[sender] = [];

  try {
    const chunk = JSON.parse(data);
    if (typeof chunk.index !== "number" || !chunk.total || !chunk.content) {
      return;
    }

    messageBuffer[sender][chunk.index] = chunk.content;

    if (messageBuffer[sender].length === chunk.total) {
      const fullMessage = messageBuffer[sender].join("");
      delete messageBuffer[sender];
      return fullMessage;
    }
  } catch (e) {}
}

export async function postOK(text) {
  const model = await toxicity.load();
  const predictions = await model.classify(text);
  const results = {};
  for (const prediction of predictions) {
    if (prediction.results[0].match) return false;
    results[prediction.label] = prediction.results[0].match;
  }
  return true;
}

export default {
  getPosts,
  importPost,
  getPost,
  newPost,
  chunkMessage,
  rankPosts,
  processChunk,
  postOK,
  catchUp,
  isBase64,
};
