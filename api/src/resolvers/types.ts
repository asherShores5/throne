/** Who is calling: the Cognito sub AppSync verified. Never an ID the client sent. */
export interface Ctx {
  sub: string;
  /** The Cognito username from the same verified token (only Delete Profile uses it, to delete the user). */
  username?: string;
}

export type Resolver = (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>;

/** One entity's resolvers, by GraphQL root type. Field names match the schema/<entity>.graphql file. */
export interface ResolverModule {
  Query: Record<string, Resolver>;
  Mutation: Record<string, Resolver>;
}
