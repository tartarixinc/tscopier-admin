/** Public host that serves function HTML as a page. The *.supabase.co host serves the same body as plain text. */
export const PUBLIC_FUNCTION_ORIGIN = "https://sso.tscopier.ai";

export function publicUnsubscribeUrl(userId: string, token: string): string {
  const url = new URL(`${PUBLIC_FUNCTION_ORIGIN}/functions/v1/email-unsubscribe`);
  url.searchParams.set("uid", userId);
  url.searchParams.set("token", token);
  return url.toString();
}
