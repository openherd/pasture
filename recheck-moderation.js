#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config();

import {
  getPostsFromLastTwoWeeks,
  checkModeration,
  updatePostModeration
} from "./utils.js";
import config from "./config.json" with { type: "json" };

async function recheckModeration() {
  console.log("Starting moderation recheck for posts from the last 14 days...");

  try {
    const posts = await getPostsFromLastTwoWeeks();
    console.log(`Found ${posts.length} posts to check`);

    if (posts.length === 0) {
      console.log("No posts to check. Exiting.");
      return;
    }

    const postEnvelopes = posts.map(post => ({
      signature: post.signature,
      publicKey: post.publicKey,
      id: post.id,
      data: JSON.parse(post.raw).data
    }));

    const moderationResults = await checkModeration(postEnvelopes, config.moderationServices);

    let updatedCount = 0;
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const isFlagged = moderationResults[i] !== null;

      if (post.moderated !== isFlagged) {
        await updatePostModeration(post.id, isFlagged);
        updatedCount++;
        console.log(`Updated post ${post.id}: moderated = ${isFlagged}${isFlagged ? ` (${moderationResults[i]})` : ''}`);
      }
    }

    console.log(`Moderation recheck complete. Updated ${updatedCount} posts.`);
  } catch (error) {
    console.error("Error during moderation recheck:", error);
    process.exit(1);
  }
}
recheckModeration();
