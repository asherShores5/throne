// In-memory stand-in for the DynamoDB document client, covering only what handler.ts uses (copied
// from NutriSage). Unsupported expressions throw, so a new resolver that needs more fails loudly
// instead of passing by accident. Extend the small parsers below when that happens.
//
// Stricter than DynamoDB on one point (Throne's rule, spec: API security): every attribute name in
// an expression must be a #placeholder, so a reserved word (status, name, count, date, ttl...) can
// never reach the live table bare. Like DynamoDB, unused #names / :values are refused too.
//
// It also stands in for IAM: inside asLambda(name, ...) (the harness runs each Lambda that way) any action,
// including each action inside a transaction, that api/src/dynamoAccess.ts doesn't grant that Lambda is
// refused with AccessDeniedException, as the live role would. infra grants exactly that list.
import { AsyncLocalStorage } from "node:async_hooks";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ACTION_OF, DYNAMO_ACCESS, type LambdaName } from "../dynamoAccess";

/** Which Lambda is running (the harness sets it per invocation); outside one (seeding, direct sends) nothing is checked. */
const running = new AsyncLocalStorage<LambdaName>();

/** Run `fn` as Lambda `name`: the fake then refuses DynamoDB actions that Lambda isn't granted. */
export function asLambda<T>(name: LambdaName, fn: () => Promise<T>): Promise<T> {
  return running.run(name, fn);
}

/** What IAM answers an action the caller's role doesn't allow. */
export class AccessDeniedException extends Error {
  name = "AccessDeniedException";
}

const COMMAND_KIND: [new (...a: any[]) => unknown, string][] = [
  [GetCommand, "GetCommand"], [PutCommand, "PutCommand"], [UpdateCommand, "UpdateCommand"],
  [DeleteCommand, "DeleteCommand"], [QueryCommand, "QueryCommand"],
];

/** Refuse, like IAM, an action the running Lambda isn't granted. */
function authorize(cmd: unknown) {
  const lambda = running.getStore();
  if (!lambda) return;
  const kinds = cmd instanceof TransactWriteCommand
    ? (cmd.input.TransactItems ?? []).flatMap((t) => Object.keys(t).filter((k) => (t as Record<string, unknown>)[k]))
    : [COMMAND_KIND.find(([c]) => cmd instanceof c)?.[1] ?? (cmd as object)?.constructor?.name ?? "?"];
  for (const kind of kinds) {
    const action = ACTION_OF[kind];
    if (!action) unsupported("command", kind);
    if (!(DYNAMO_ACCESS[lambda] as readonly string[]).includes(action)) {
      throw new AccessDeniedException(`${lambda} is not authorized to perform dynamodb:${action} (api/src/dynamoAccess.ts)`);
    }
  }
}

type Rec = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

export class ConditionalCheckFailedException extends Error {
  name = "ConditionalCheckFailedException";
}

export class TransactionCanceledException extends Error {
  name = "TransactionCanceledException";
  constructor(public CancellationReasons: { Code: string }[]) {
    super(`Transaction cancelled [${CancellationReasons.map((r) => r.Code).join(", ")}]`);
  }
}

const keyOf = (k: Rec) => `${k.PK}\u0000${k.SK}`;

// Mirrors marshallOptions.removeUndefinedValues and keeps stored records unaliased.
function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, clean(x)])) as T;
  }
  return v;
}

function unsupported(what: string, expr: string): never {
  throw new Error(`fakeDynamo: unsupported ${what}: ${expr}`);
}

/** What DynamoDB throws for a malformed request (and this fake for an un-aliased name). */
export class ValidationException extends Error {
  name = "ValidationException";
}

/** Every #name and :value must appear in one of the request's expressions (DynamoDB refuses unused ones). */
function checkPlaceholders(exprs: (string | undefined)[], names: Names, values: Values) {
  const used = new Set(exprs.filter(Boolean).join(" ").match(/[#:][A-Za-z0-9_]+/g) ?? []);
  const unused = [...Object.keys(names ?? {}), ...Object.keys(values ?? {})].filter((k) => !used.has(k));
  if (unused.length) throw new ValidationException(`fakeDynamo: unused expression placeholders: ${unused.join(", ")}`);
}

function attr(token: string, names: Names) {
  const t = token.trim();
  if (t.startsWith("#")) return names?.[t] ?? unsupported("name placeholder", t);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    throw new ValidationException(`fakeDynamo: un-aliased attribute name "${t}"; use a #placeholder in ExpressionAttributeNames`);
  }
  return unsupported("attribute path", t);
}

/** rec[name], with the name resolved even when there's no record (so a bare name is refused either way). */
const field = (rec: Rec | undefined, name: string) => rec?.[name];

function operand(token: string, rec: Rec | undefined, names: Names, values: Values): unknown {
  const t = token.trim();
  // if_not_exists(path,:default), written without spaces.
  const ine = /^if_not_exists\(([^,]+),([^)]+)\)$/.exec(t);
  if (ine) return field(rec, attr(ine[1], names)) ?? operand(ine[2], rec, names, values);
  if (t.startsWith(":")) {
    if (!values || !(t in values)) unsupported("missing value placeholder", t);
    return values[t];
  }
  return field(rec, attr(t, names));
}

function compare(a: unknown, op: string, b: unknown) {
  if (op === "=") return a === b;
  // Like DynamoDB, any comparison with a missing attribute is false, `<>` included.
  if (a === undefined || b === undefined) return false;
  if (op === "<>") return a !== b;
  const [x, y] = [a as number | string, b as number | string];
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

function evalTerm(term: string, rec: Rec | undefined, names: Names, values: Values): boolean {
  const t = term.trim();
  let m = /^attribute_not_exists\((.+)\)$/.exec(t);
  if (m) return field(rec, attr(m[1], names)) === undefined;
  m = /^attribute_exists\((.+)\)$/.exec(t);
  if (m) return field(rec, attr(m[1], names)) !== undefined;
  m = /^begins_with\((.+),(.+)\)$/.exec(t);
  if (m) return String(operand(m[1], rec, names, values) ?? "\u0000").startsWith(String(operand(m[2], rec, names, values)));
  m = /^(\S+)\s*(<>|<=|>=|=|<|>)\s*(\S+)$/.exec(t);
  if (m) return compare(operand(m[1], rec, names, values), m[2], operand(m[3], rec, names, values));
  return unsupported("condition", t);
}

/** Flat AND/OR with AND binding tighter; no parentheses or NOT. */
function evalCondition(expr: string, rec: Rec | undefined, names: Names, values: Values) {
  // `x BETWEEN a AND b` (key conditions) is `x >= a AND x <= b`.
  expr = expr.replace(/(\S+)\s+BETWEEN\s+(\S+)\s+AND\s+(\S+)/g, "$1 >= $2 AND $1 <= $3");
  return expr.split(/\s+OR\s+/).some((clause) => clause.split(/\s+AND\s+/).every((t) => evalTerm(t, rec, names, values)));
}

function applyUpdate(expr: string, rec: Rec, names: Names, values: Values) {
  const parts = expr.split(/\b(SET|REMOVE)\b/).map((s) => s.trim()).filter(Boolean);
  if (parts.length % 2) unsupported("update expression", expr);
  const out: Rec = { ...rec };
  for (let i = 0; i < parts.length; i += 2) {
    // Commas between actions, not inside if_not_exists(...).
    const items = parts[i + 1].split(/,(?![^(]*\))/).map((s) => s.trim());
    if (parts[i] === "REMOVE") {
      for (const a of items) delete out[attr(a, names)];
      continue;
    }
    for (const a of items) {
      const m = /^(\S+)\s*=\s*(\S+)(?:\s*([+-])\s*(\S+))?$/.exec(a);
      if (!m) unsupported("SET action", a);
      let v = operand(m[2], rec, names, values);
      if (m[3]) {
        const r = operand(m[4], rec, names, values) as number;
        if (typeof v !== "number" || typeof r !== "number") unsupported("arithmetic on non-numbers", a);
        v = m[3] === "+" ? v + r : v - r;
      }
      out[attr(m[1], names)] = v;
    }
  }
  return out;
}

export class FakeDocClient {
  private table = new Map<string, Rec>();

  /** Empty the table. Call from beforeEach. */
  reset() {
    this.table.clear();
  }

  /** Raw view of every stored record (PK/SK included), for seeding checks and debugging. */
  dump(): Rec[] {
    return [...this.table.values()].map((r) => structuredClone(r));
  }

  /** Write a record directly, bypassing resolvers (e.g. to seed legacy data). */
  seed(...recs: Rec[]) {
    for (const r of recs) this.table.set(keyOf(r), clean(r));
  }

  async send(cmd: unknown): Promise<any> {
    authorize(cmd);
    if (cmd instanceof TransactWriteCommand) return this.transactWrite(cmd.input);
    if (cmd instanceof GetCommand) {
      const r = this.table.get(keyOf(cmd.input.Key!));
      return { Item: r && structuredClone(r) };
    }
    if (cmd instanceof PutCommand) {
      const { Item, ConditionExpression: ce, ExpressionAttributeNames: n, ExpressionAttributeValues: v } = cmd.input;
      checkPlaceholders([ce], n, v);
      const k = keyOf(Item!);
      if (ce && !evalCondition(ce, this.table.get(k), n, v)) throw new ConditionalCheckFailedException("put condition failed");
      this.table.set(k, clean(Item!));
      return {};
    }
    if (cmd instanceof UpdateCommand) {
      const { Key, UpdateExpression, ConditionExpression: ce, ExpressionAttributeNames: n, ExpressionAttributeValues: v, ReturnValues } = cmd.input;
      checkPlaceholders([UpdateExpression, ce], n, v);
      const k = keyOf(Key!);
      const existing = this.table.get(k);
      if (ce && !evalCondition(ce, existing, n, v)) throw new ConditionalCheckFailedException("update condition failed");
      const next = clean(applyUpdate(UpdateExpression!, existing ?? { ...Key }, n, v));
      this.table.set(k, next);
      if (ReturnValues === "ALL_NEW") return { Attributes: structuredClone(next) };
      if (ReturnValues && ReturnValues !== "NONE") unsupported("ReturnValues", ReturnValues);
      return {};
    }
    if (cmd instanceof DeleteCommand) {
      const { Key, ConditionExpression: ce, ExpressionAttributeNames: n, ExpressionAttributeValues: v, ReturnValues } = cmd.input;
      checkPlaceholders([ce], n, v);
      const k = keyOf(Key!);
      const existing = this.table.get(k);
      if (ce && !evalCondition(ce, existing, n, v)) throw new ConditionalCheckFailedException("delete condition failed");
      this.table.delete(k);
      return ReturnValues === "ALL_OLD" ? { Attributes: existing } : {};
    }
    if (cmd instanceof QueryCommand) return this.query(cmd.input);
    return unsupported("command", (cmd as object)?.constructor?.name ?? String(cmd));
  }

  /**
   * All-or-nothing Put/Update/Delete/ConditionCheck like DynamoDB: if any condition fails, nothing is written and a
   * TransactionCanceledException carries one CancellationReason per action, in order.
   */
  private transactWrite(input: TransactWriteCommand["input"]) {
    const actions = (input.TransactItems ?? []).map((t) => {
      if (t.Put) return { key: keyOf(t.Put.Item!), item: t.Put.Item as Rec, ...t.Put };
      if (t.Delete) return { key: keyOf(t.Delete.Key!), item: undefined, ...t.Delete };
      if (t.Update) return { key: keyOf(t.Update.Key!), item: undefined, update: t.Update, ...t.Update };
      if (t.ConditionCheck) return { key: keyOf(t.ConditionCheck.Key!), item: undefined, check: true, ...t.ConditionCheck };
      return unsupported("transaction action", Object.keys(t).join(","));
    });
    for (const a of actions) {
      checkPlaceholders([a.ConditionExpression, "update" in a ? a.update?.UpdateExpression : undefined], a.ExpressionAttributeNames, a.ExpressionAttributeValues);
    }
    if (new Set(actions.map((a) => a.key)).size !== actions.length) unsupported("transaction", "two actions on one item");
    const reasons = actions.map((a) =>
      !a.ConditionExpression ||
      evalCondition(a.ConditionExpression, this.table.get(a.key), a.ExpressionAttributeNames, a.ExpressionAttributeValues)
        ? { Code: "None" }
        : { Code: "ConditionalCheckFailed" },
    );
    if (reasons.some((r) => r.Code !== "None")) throw new TransactionCanceledException(reasons);
    for (const a of actions) {
      if ("check" in a) continue;
      if ("update" in a && a.update) {
        const { Key, UpdateExpression, ExpressionAttributeNames: n, ExpressionAttributeValues: v } = a.update;
        this.table.set(a.key, clean(applyUpdate(UpdateExpression!, this.table.get(a.key) ?? { ...Key }, n, v)));
      } else if (a.item) this.table.set(a.key, clean(a.item));
      else this.table.delete(a.key);
    }
    return {};
  }

  private query(input: QueryCommand["input"]) {
    const { IndexName, FilterExpression, Select, KeyConditionExpression: kce, ExpressionAttributeNames: n, ExpressionAttributeValues: v } = input;
    if (IndexName) unsupported("IndexName", IndexName);
    if (FilterExpression) unsupported("FilterExpression", FilterExpression);
    if (Select && Select !== "COUNT") unsupported("Select", Select);
    if (input.ProjectionExpression) unsupported("ProjectionExpression", input.ProjectionExpression);
    checkPlaceholders([kce], n, v);
    const terms = kce!.split(/\s+AND\s+/);
    const pk = /^(\S+)\s*=\s*(\S+)$/.exec(terms[0].trim());
    if (!pk || attr(pk[1], n) !== "PK") unsupported("key condition", kce!);
    let rows = [...this.table.values()]
      .filter((r) => evalCondition(terms.join(" AND "), r, n, v))
      .sort((a, b) => (String(a.SK) < String(b.SK) ? -1 : 1));
    if (input.ScanIndexForward === false) rows.reverse();
    // Like DynamoDB: resume strictly after the start key's position (it needn't still exist),
    // Limit caps items evaluated before any filtering, and a page that hits Limit always carries
    // LastEvaluatedKey, even when nothing is left (the next page is then empty).
    if (input.ExclusiveStartKey) {
      const start = String(input.ExclusiveStartKey.SK);
      rows = rows.filter((r) => (input.ScanIndexForward === false ? String(r.SK) < start : String(r.SK) > start));
    }
    const page = input.Limit ? rows.slice(0, input.Limit) : rows;
    const last = page.at(-1);
    const LastEvaluatedKey = input.Limit && page.length === input.Limit && last ? { PK: last.PK, SK: last.SK } : undefined;
    // Select COUNT: like DynamoDB, a Count and no Items.
    if (Select === "COUNT") return { Count: page.length, LastEvaluatedKey };
    return { Items: page.map((r) => structuredClone(r)), Count: page.length, LastEvaluatedKey };
  }
}
