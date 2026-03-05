import { apiFetch } from "@/lib/api";

type ServerStatusResponse = {
  success: boolean;
  servers: Array<{
    server_id: string;
    name: string;
    region: string;
    players: number;
    status: "online" | "offline";
    state: string;
    map?: string | null;
    mode?: string | null;
  }>;
};

export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const data = await apiFetch<ServerStatusResponse>("/servers/status").catch(() => ({ success: false, servers: [] }));

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Server Status</h1>
        <p className="mt-1 text-sm text-white/70">Live infrastructure health for FragHub servers.</p>
      </section>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-white/5 text-left text-white/65">
              <tr>
                <th className="px-4 py-3">Server Name</th>
                <th className="px-4 py-3">Region</th>
                <th className="px-4 py-3">Players</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.servers.map((server) => (
                <tr key={server.server_id} className="border-t border-white/10">
                  <td className="px-4 py-3">{server.name}</td>
                  <td className="px-4 py-3">{server.region}</td>
                  <td className="px-4 py-3">{server.players}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded px-2 py-1 text-xs font-semibold ${
                        server.status === "online" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                      }`}
                    >
                      {server.status === "online" ? "Online" : "Offline"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.servers.length === 0 && <div className="p-6 text-sm text-white/70">No server data available right now.</div>}
      </section>
    </div>
  );
}

