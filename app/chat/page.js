import { SiteHeader } from '../../components/site-header';
import { ChatWorkspace } from '../../components/chat/chat-workspace';
import { AuthButton } from '@/components/auth/auth-button';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Helper Agent · QIG Memory API',
  description: 'Chat with the QIG helper agent to operate the memory store and kernel mesh.',
};

export default async function ChatPage() {
  const session = await getSession();

  if (!session) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <SiteHeader />
        <main className="mx-auto flex max-w-md flex-col items-center gap-5 px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Helper agent access
          </h1>
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
            The helper agent can read, write and delete memory records, so it is protected. Sign in
            with Vercel to operate the store — your session authorizes every action server-side.
          </p>
          <AuthButton />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <ChatWorkspace />
    </div>
  );
}
