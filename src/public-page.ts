/** Publish only an explicitly enabled service number; never derive a recipient. */
export function publicPage(html: string, phone?: string, analytics = false) {
  html = html.replace(
    'data-website-analytics="off"',
    `data-website-analytics="${analytics ? "on" : "off"}"`,
  );
  if (!phone) return html;
  if (!/^\+[1-9]\d{7,14}$/.test(phone))
    throw new Error("Public texting requires an E.164 service number.");
  const href = `sms:${phone}?body=${encodeURIComponent("Hey ClawdTime")}`;
  return html
    .replace('data-availability="preview"', 'data-availability="invited"')
    .replace(
      'id="text-it" class="text-fallback',
      'id="text-it" data-text-ready class="text-fallback',
    )
    .replace(
      /href="\/guides\/getting-started"\s+data-pilot-setup/g,
      `href="${href}" data-sms`,
    )
    .replace(
      /<!-- TEXT_CONTACT -->[\s\S]*?<!-- \/TEXT_CONTACT -->/,
      `<p>Text <a href="${href}" data-sms>${phone}</a> to get started. Your message opens in Messages; tap Send. If the greeting is blank, type “Hey ClawdTime.”</p><p class="micro-label">Invited testers only while we finish the pilot.</p>`,
    );
}
