import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/csgofaceit";

export const db = new Pool({ connectionString });

export async function withTransaction<T>(fn: (client: Pool) => Promise<T>): Promise<T> {
  return fn(db);
}