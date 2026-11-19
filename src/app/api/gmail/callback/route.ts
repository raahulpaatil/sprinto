// Disabled. Connecting or relinking a Gmail account from a public page is not safe without sign-in, so this route does not exist.
// The existing connection is used server-side only; the refresh token is never exposed.
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
export const GET = notFound;
export const POST = notFound;
