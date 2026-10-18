import { getSettings } from "@/lib/localDb";

/**
 * Turning on a tunnel puts the gateway on the internet. Refuse unless the
 * dashboard needs a real password and every API request needs a key.
 * Returns a reason string, or null when it's safe.
 */
export async function tunnelExposureProblem() {
  const s = await getSettings();
  if (s.requireLogin === false) return 'Turn on "Require login" before going public.';
  if (!s.password) return "Change the default dashboard password before going public.";
  if (!s.requireApiKey) return 'Turn on "Require API key" before going public.';
  return null;
}
