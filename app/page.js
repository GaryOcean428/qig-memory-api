export default function Page() {
  const mcpUrl = 'https://qig-memory-api.vercel.app/api/mcp';
  const claudeConfig = JSON.stringify({
    mcpServers: {
      'qig-memory': {
        url: mcpUrl
      }
    }
  }, null, 2);

  return (
    <div style={{padding: '40px', fontFamily: 'system-ui'}}>
      <h1>QIG Memory API + MCP Connector</h1>
      <p>Persistent memory for QIG/Pantheon agents with MCP support.</p>
      
      <h2>MCP HTTP URL</h2>
      <div style={{background: '#f0f0f0', padding: '12px', borderRadius: '8px', marginBottom: '20px'}}>
        <code>{mcpUrl}</code>
        <button onClick={() => navigator.clipboard.writeText(mcpUrl)}>Copy URL</button>
      </div>

      <h2>JSON Config for CLIs (copy-paste)</h2>
      <pre style={{background: '#f4f4f4', padding: '20px', overflow: 'auto'}}>{claudeConfig}</pre>
      <button onClick={() => navigator.clipboard.writeText(claudeConfig)}>Copy Claude Code / Cursor Config</button>
      
      <p>More configs and instructions in README.md</p>
    </div>
  );
}
