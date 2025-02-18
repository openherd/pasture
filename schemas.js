import { z } from "zod";

export const newPost = z.object({
  latitude: z.union([z.string(), z.number()]),
  longitude: z.union([z.string(), z.number()]),
  text: z.string(),
  date: z.string(),
  parent: z.string().optional(),
});

export const catchUp = z
  .object({
    max: z.number().min(1).optional().default(100),
  })
  .partial()
  .default({});

export default {
  newPost,
  catchUp,
};
