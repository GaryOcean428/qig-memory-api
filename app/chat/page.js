import { SiteHeader } from '../../components/site-header';
import { ChatWorkspace } from '../../components/chat/chat-workspace';

export const metadata = {
  title: 'Helper Agent · QIG Memory API',
  description: 'Chat with the QIG helper agent to operate the memory store and kernel mesh.',
};

export default function ChatPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <ChatWorkspace />
    </div>
  );
}
