const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const TELEGRAM_HOSTS = ['t.me', 'telegram.me', 'telegram.dog'];

 function parseTelegramInput(telegram) {
  const input = (telegram || '').trim();
  if (!input) return { value: null };

  // 1. Phone number: optional +, digits, spaces, dashes, dots, parentheses
  if (/^\+?[\d\s\-().]+$/.test(input)) {
    const digits = input.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      return { error: 'Phone number must have 7 to 15 digits (e.g. +85512345678).' };
    }
    return { value: `https://t.me/+${digits}`, type: 'phone' };
  }

  // 2. URL: with or without protocol (t.me/user, https://t.me/user, telegram.me/user)
  const looksLikeUrl = /^(https?:\/\/|tg:\/\/)/i.test(input) ||
    TELEGRAM_HOSTS.some((h) => input.toLowerCase().startsWith(h + '/'));

  if (looksLikeUrl) {
    let url;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      return { error: 'Telegram link is not a valid URL.' };
    }

    // tg://resolve?domain=username
    if (url.protocol === 'tg:') {
      const domain = url.searchParams.get('domain');
      if (url.hostname === 'resolve' && USERNAME_RE.test(domain || '')) {
        return { value: `https://t.me/${domain}`, type: 'username' };
      }
      return { error: 'Unsupported Telegram link.' };
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      return { error: 'Telegram must be a valid http(s) URL.' };
    }
    if (!TELEGRAM_HOSTS.includes(url.hostname.toLowerCase())) {
      return { error: 'Link must be a t.me URL (e.g. https://t.me/username).' };
    }

    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path.startsWith('+')) {
      const digits = path.replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) {
        return { value: `https://t.me/+${digits}`, type: 'phone' };
      }
      return { error: 'Invalid phone number in Telegram link.' };
    }
    if (!USERNAME_RE.test(path)) {
      return { error: 'Invalid Telegram username in link.' };
    }
    return { value: `https://t.me/${path}`, type: 'username' };
  }

  // 3. Plain username, with or without @
  const username = input.replace(/^@/, '');
  if (!USERNAME_RE.test(username)) {
    return {
      error:
        'Enter a phone number, @username, or t.me link. Usernames are 5–32 characters: letters, numbers, underscores, starting with a letter.',
    };
  }
  return { value: `https://t.me/${username}`, type: 'username' };
}

module.exports = { parseTelegramInput };