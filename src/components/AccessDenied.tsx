import { ShieldAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/**
 * The page-level "you don't have permission" state. The sidebar nav already
 * hides a link the signed-in user can't use (useVisibleNavGroups), and the
 * API is the real enforcement point regardless — this only covers a
 * bookmarked or typed-in URL, so the page reads as "not for you" rather than
 * a blank list or a raw error toast sitting under an empty table.
 */
export function AccessDenied({ message, hint }: { message: string; hint: string }) {
  return (
    <Card>
      <CardContent className="text-center py-12 px-4">
        <ShieldAlert className="h-8 w-8 text-gray-300 mx-auto mb-2" />
        <p className="text-gray-500">{message}</p>
        <p className="text-xs text-gray-400 mt-1">{hint}</p>
      </CardContent>
    </Card>
  );
}
