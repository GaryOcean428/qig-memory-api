import { LegalPage, LegalSection } from '@/components/legal/legal-page';

export const metadata = {
  title: 'Privacy Policy — QIG Memory API',
  description:
    'How the QIG Memory API collects, uses, stores, and protects data when you use the service.',
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="July 13, 2026"
      intro="This Privacy Policy explains what information the QIG Memory API collects, how it is used, and the choices you have. It applies to the REST API, MCP server, helper agent, and Sign in with Vercel authentication."
    >
      <LegalSection heading="Information we collect">
        <p>We collect the following categories of information:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <span className="font-medium text-foreground">Memory records.</span> The keys, values,
            categories, and metadata you write to the memory store.
          </li>
          <li>
            <span className="font-medium text-foreground">Kernel mesh data.</span> Agent identifiers,
            declared capabilities, and 64-dimensional basin coordinates submitted via heartbeats.
          </li>
          <li>
            <span className="font-medium text-foreground">Authentication data.</span> When you sign
            in with Vercel, we receive basic profile information (such as your name, email, and user
            identifier) and OAuth tokens needed to establish a session.
          </li>
          <li>
            <span className="font-medium text-foreground">Operational data.</span> Standard request
            metadata such as timestamps and endpoint usage required to operate the Service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="How we use information">
        <p>We use information solely to provide and maintain the Service, specifically to:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>Store and return memory records and kernel coordinates on request.</li>
          <li>Compute Fisher-Rao distances between agents in the kernel mesh.</li>
          <li>Authenticate requests and maintain your signed-in session.</li>
          <li>Diagnose issues and protect the Service against abuse.</li>
        </ul>
        <p>We do not sell your data or use it for advertising.</p>
      </LegalSection>

      <LegalSection heading="Storage and processing">
        <p>
          Memory records and kernel data are stored using Vercel Blob storage. Authentication is
          handled through Vercel’s OAuth (Sign in with Vercel), and session state is kept in a
          secure, HTTP-only cookie. Data is processed on Vercel’s infrastructure.
        </p>
      </LegalSection>

      <LegalSection heading="Data sharing">
        <p>
          We share information only with infrastructure providers (such as Vercel) that process data
          on our behalf to operate the Service, and where required by law. Note that data submitted
          to the shared kernel mesh — such as agent coordinates — is, by design, visible to other
          participating agents in the council.
        </p>
      </LegalSection>

      <LegalSection heading="Retention">
        <p>
          Memory records persist until deleted through the API or by an operator. Session cookies
          expire according to their configured lifetime. You may request deletion of data associated
          with your account by removing the underlying records or contacting the maintainers.
        </p>
      </LegalSection>

      <LegalSection heading="Security">
        <p>
          We use reasonable technical measures — including authentication, HTTP-only session cookies,
          and access controls — to protect data. However, no method of transmission or storage is
          completely secure, and we cannot guarantee absolute security.
        </p>
      </LegalSection>

      <LegalSection heading="Your choices">
        <p>
          You can sign out at any time to end your session and revoke the associated tokens. You can
          delete memory records you created through the API. For questions about your data, contact
          the maintainers of the QIG / Pantheon project.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to this policy">
        <p>
          We may update this policy periodically. Material changes will be reflected by updating the
          “Last updated” date above.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
