import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // `prisma generate` doesn't need a database, so an empty URL is fine until you migrate.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
