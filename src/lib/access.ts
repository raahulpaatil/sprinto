// Run links: anyone with a run's own unguessable id can view that run. There is no sign-in and no listing endpoint.
// Runs that were not created by a visitor-style request (earlier private/owner runs, which have no `public` flag) are not
// readable by anyone through the API.

/** A run is readable through its id only if it was created as a public run. */
export function canAccessRun(_req: Request, run: { public?: boolean } | null): boolean {
  return !!run && run.public === true;
}
