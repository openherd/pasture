const { PrismaClient } = require("@prisma/client")
const openpgp = require("openpgp")
const tf = require("@tensorflow/tfjs-node");
const toxicity = require("@tensorflow-models/toxicity");

const prisma = new PrismaClient()
const geolib = require("geolib")
module.exports = {
    async getPosts(parent) {
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

        const posts = await prisma.post.findMany({
            where: {
                createdAt: {
                    gte: twoWeeksAgo
                },
                parent
            }
        });

        return posts;
    },
    async importPost({ signature, publicKey, data, node, from }) {
        const key = await openpgp.readKey({
            armoredKey: publicKey
        });
        const signedMessage = await openpgp.createMessage({
            text: data
        });
        const signatureObject = await openpgp.readSignature({
            armoredSignature: signature
        });
        const verificationResult = await openpgp.verify({
            message: signedMessage,
            signature: signatureObject,
            verificationKeys: key
        });
        const { verified } = verificationResult.signatures[0];

        try {
            await verified; // throws on invalid signature
            const json = JSON.parse(data)
            if (process.env.MODERATE_POSTS) {
                const ok = await this.postOK(json.text)
                if (!ok) return;
            }
            const existingPost = await prisma.post.findFirst({
                where: {
                    id: key.getFingerprint()
                }
            })
            if (!existingPost) {
                await prisma.post.create({
                    data: {
                        id: key.getFingerprint(),
                        createdAt: new Date(json.date),
                        text: json.text,
                        parent: json.parent,
                        latitude: json.latitude.toString(),
                        longitude: json.longitude.toString(),
                        publicKey: publicKey
                    }
                })
            }
        } catch (e) {
            console.error('Signature verification failed:', e);
            await node.hangUp(from);
        }
        return null;
    },
    async getPost(id) {
        return await prisma.post.findFirst({
            where: {
                id
            }
        })
    },
    async newPost({ latitude, longitude, text, parent, node }) {
        const postDate = new Date()

        const { privateKey, publicKey } = await openpgp.generateKey({
            type: 'rsa',
            rsaBits: 4096,
            userIDs: [{ name: 'Anon', email: 'anon@example.com' }],
            passphrase: "post"
        });
        const key = await openpgp.readKey({ armoredKey: privateKey });

        await prisma.post.create({
            data: {
                id: key.getFingerprint(),
                text,
                latitude,
                longitude,
                privateKey,
                publicKey
            }
        })
        const textToSign = JSON.stringify({
            id: key.getFingerprint(),
            text,
            latitude,
            date: postDate.toISOString(),
            longitude
        })
        const message = await openpgp.createMessage({ text: textToSign });

        const privateKeyObj = await openpgp.readPrivateKey({ armoredKey: privateKey });
        const decryptedPrivateKey = await openpgp.decryptKey({ privateKey: privateKeyObj, passphrase: 'post' });

        const signature = await openpgp.sign({
            message: message,
            signingKeys: decryptedPrivateKey,
            detached: true
        });
        var packet = JSON.stringify({
            signature: signature,
            publicKey,
            id: key.getFingerprint(),
            data: textToSign
        })

        return packet;
    },
    chunkMessage(message) {
        const MAX_CHUNK_SIZE = 500;
        const chunks = [];
        for (let i = 0; i < message.length; i += MAX_CHUNK_SIZE) {
            chunks.push(message.slice(i, i + MAX_CHUNK_SIZE));
        }
        return chunks;
    },
    rankPosts(posts, userLat, userLon) {
        const alpha = 0.3;
        const beta = 0.3;
        const now = Date.now();

        return posts.map(post => {
            const distance = geolib.getDistance({
                latitude: userLat,
                longitude: userLon
            },
                {
                    latitude: post.latitude,
                    longitude: post.longitude
                })
            const hoursAgo = (now - new Date(post.date).getTime()) / 3600000;

            const score = Math.exp(-alpha * distance) * Math.exp(-beta * hoursAgo);

            return { ...post, score };
        }).sort((a, b) => b.score - a.score);
    },
    processChunk(sender, data, messageBuffer, node) {
        if (!messageBuffer[sender]) messageBuffer[sender] = [];

        try {
            const chunk = JSON.parse(data);
            if (typeof chunk.index !== "number" || !chunk.total || !chunk.content) {
                console.log(`Invalid chunk from ${sender}, disconnecting...`);
                node.hangUp(sender);
                return;
            }

            messageBuffer[sender][chunk.index] = chunk.content;

            if (messageBuffer[sender].length === chunk.total) {
                const fullMessage = messageBuffer[sender].join('');
                delete messageBuffer[sender];
                return fullMessage;
            }
        } catch (e) {
            console.log(`Invalid chunk format from ${sender}, disconnecting...`);
            node.hangUp(sender);
        }
    },
    async postOK(text) {
        const model = await toxicity.load();
        const predictions = await model.classify(text);
        const results = {};
        for (const prediction of predictions) {
            if (prediction.results[0].match) return false
            results[prediction.label] = prediction.results[0].match;
        }
        return true;

    }
}