const { z } = require("zod")

module.exports = {
    newPost: z.object({
        latitude: z.union([z.string(), z.number()]),
        longitude: z.union([z.string(), z.number()]),
        text: z.string(),
        date: z.string(),
        parent: z.string().optional(),
    })
}