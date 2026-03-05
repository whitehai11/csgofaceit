import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      playerId: string;
      steamId: string;
      role: string;
    };
    user: {
      playerId: string;
      steamId: string;
      role: string;
    };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

export async function registerAuth(fastify: FastifyInstance): Promise<void> {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32 || jwtSecret === "change-me") {
    throw new Error("JWT_SECRET must be set to a strong value (>=32 chars)");
  }

  await fastify.register(fastifyJwt, { secret: jwtSecret });

  fastify.decorate("authenticate", async (request: FastifyRequest) => {
    await request.jwtVerify();
  });
}

export default fp(registerAuth);
