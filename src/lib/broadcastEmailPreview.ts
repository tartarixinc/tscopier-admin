import { buildCampaignEmailHtml, recipientFirstName } from '../../supabase/functions/_shared/campaignEmailLayout';
import { resolveEmailLogoUrl } from '../../supabase/functions/_shared/brandEmailAssets';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function messageToHtml(message: string): string {
  return message
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .filter((block) => block.trim().length > 0)
    .map((block) => `<p style="margin:0 0 16px 0;">${escapeHtml(block).split('\n').join('<br/>')}</p>`)
    .join('');
}

export function buildBroadcastPreviewHtml(input: {
  title: string;
  message: string;
  ctaLabel: string;
  ctaUrl: string;
  displayName: string | null;
}): string {
  const appUrl = 'https://app.tscopier.ai';
  const logoUrl = resolveEmailLogoUrl({
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string,
    appUrl,
    variant: 'dark',
  });
  const ctaLabel = input.ctaLabel.trim();
  const ctaUrl = input.ctaUrl.trim();
  const cta = ctaLabel && /^https?:\/\//i.test(ctaUrl)
    ? { label: ctaLabel, url: ctaUrl }
    : { label: 'Open TScopier', url: appUrl };

  return buildCampaignEmailHtml({
    appUrl,
    logoUrl,
    preheader: escapeHtml(input.message.replace(/\s+/g, ' ').trim().slice(0, 140)),
    eyebrow: 'TScopier',
    title: escapeHtml(input.title.trim()),
    greeting: escapeHtml(recipientFirstName({
      user_id: 'preview',
      email: '',
      display_name: input.displayName,
      first_name: null,
    })),
    bodyHtml: messageToHtml(input.message),
    primaryCta: cta,
    closingHtml: 'Questions? Email us at <a href="mailto:support@tscopier.ai" style="color:#0d9488;text-decoration:underline;">support@tscopier.ai</a>',
    unsubscribeUrl: '#',
  });
}
