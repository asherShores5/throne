/** Who is calling: the Cognito sub AppSync verified. Never an ID the client sent. */
export interface Ctx {
  sub: string;
}

export type Resolver = (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>;

/** One entity's resolvers, by GraphQL root type. Field names match the schema/<entity>.graphql file. */
export interface ResolverModule {
  Query: Record<string, Resolver>;
  Mutation: Record<string, Resolver>;
}
