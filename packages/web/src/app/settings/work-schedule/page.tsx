import { redirect } from 'next/navigation';

/**
 * /settings/work-schedule moved into the consolidated /settings page (Phase
 * 4g). The redirect keeps old links and bookmarks landing on the right section.
 */
export default function WorkSchedulePage() {
  redirect('/settings#work-schedule');
}
