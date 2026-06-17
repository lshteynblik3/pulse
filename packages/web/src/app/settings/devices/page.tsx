import { redirect } from 'next/navigation';

/**
 * /settings/devices moved into the consolidated /settings page (Phase 4g).
 * The redirect keeps old links and bookmarks landing on the right section.
 */
export default function DevicesPage() {
  redirect('/settings#devices');
}
