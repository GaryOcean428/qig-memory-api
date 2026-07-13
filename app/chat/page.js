import { SiteHeader } from '../../components/site-header';
import { ChatPanel } from '../../components/chat/chat-panel';
import { GridPattern } from '../../components/grid-pattern';

export const metadata = {
  title: 'Helper Agent · QIG Memory API',
  description: 'Chat with the QIG helper agent to operate the memory store and kernel mesh.',
};

export default function ChatPage() {
  return (
    <div className="relative min-h-screen bg-background">
      <GridPattern />
      <SiteHeader />
      <main className="relative mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
        <div className="mb-8 space-y-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary animate-dot-glow" />
            Live agent
          </span>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground text-balance">Helper Agent</h1>
          <p className="max-w-xl text-sm text-muted-foreground text-pretty">
            A tool-using assistant wired to this deployment. It can read and write memory records and
            report the state of the kernel mesh — try one of the prompts below.
          </p>
        </div>
        <ChatPanel />
      </main>
    </div>
  );
}
