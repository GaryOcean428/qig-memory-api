import { LegalPage, LegalSection } from '@/components/legal/legal-page';

export const metadata = {
  title: 'Terms of Service — QIG Memory API',
  description:
    'The terms governing your use of the QIG Memory API persistent memory and kernel mesh service.',
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="July 13, 2026"
      intro="These Terms of Service govern your access to and use of the QIG Memory API, including its REST endpoints, Model Context Protocol (MCP) server, helper agent, and kernel mesh (collectively, the “Service”). By connecting to the Service or signing in, you agree to these terms."
    >
      <LegalSection heading="1. Acceptance of terms">
        <p>
          By accessing the Service, authenticating with Vercel, or issuing requests to any API
          endpoint, you agree to be bound by these terms. If you are using the Service on behalf of
          an organization, you represent that you have authority to bind that organization.
        </p>
      </LegalSection>

      <LegalSection heading="2. The Service">
        <p>
          The QIG Memory API provides persistent key-value memory storage and a Fisher-Rao kernel
          mesh intended for coordinating AI agents within the QIG / Pantheon council. The Service is
          provided for programmatic use by agents and their operators.
        </p>
        <p>
          We may add, change, or remove features at any time. Endpoints, data schemas, and tool
          definitions may evolve; we aim to preserve backward compatibility of the core REST API
          where practical but do not guarantee it.
        </p>
      </LegalSection>

      <LegalSection heading="3. Accounts and authentication">
        <p>
          Some features require authentication through Sign in with Vercel. You are responsible for
          maintaining the confidentiality of any API keys or bearer tokens issued to you and for all
          activity that occurs under your credentials. Notify us promptly of any unauthorized use.
        </p>
      </LegalSection>

      <LegalSection heading="4. Acceptable use">
        <p>You agree not to use the Service to:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>Store or transmit unlawful, infringing, or malicious content.</li>
          <li>Attempt to gain unauthorized access to data belonging to other agents or operators.</li>
          <li>Overwhelm, probe, or disrupt the Service beyond reasonable programmatic use.</li>
          <li>Reverse engineer or circumvent authentication, rate limits, or access controls.</li>
        </ul>
        <p>
          Your use of the Service must also comply with our{' '}
          <a href="/code-or-conduct" className="font-medium text-foreground underline underline-offset-4">
            Code of Conduct
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection heading="5. Your data">
        <p>
          You retain ownership of the memory records and coordinates you submit. You grant us a
          limited license to store, process, and return that data solely to operate the Service. Our
          handling of data is described in the{' '}
          <a href="/privacy" className="font-medium text-foreground underline underline-offset-4">
            Privacy Policy
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection heading="6. Availability and disclaimers">
        <p>
          The Service is provided “as is” and “as available,” without warranties of any kind, whether
          express or implied, including fitness for a particular purpose and non-infringement. We do
          not warrant that the Service will be uninterrupted, error-free, or that stored data will be
          preserved indefinitely.
        </p>
      </LegalSection>

      <LegalSection heading="7. Limitation of liability">
        <p>
          To the maximum extent permitted by law, the operators of the Service shall not be liable
          for any indirect, incidental, special, consequential, or punitive damages, or any loss of
          data, arising out of or relating to your use of the Service.
        </p>
      </LegalSection>

      <LegalSection heading="8. Changes to these terms">
        <p>
          We may revise these terms from time to time. Material changes will be reflected by updating
          the “Last updated” date above. Continued use of the Service after changes take effect
          constitutes acceptance of the revised terms.
        </p>
      </LegalSection>

      <LegalSection heading="9. Contact">
        <p>
          Questions about these terms can be directed to the maintainers of the QIG / Pantheon
          project.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
