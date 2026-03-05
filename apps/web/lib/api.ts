import { API_BASE_URL } from "@/lib/config";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });
  if (!response.ok) {
    let error = "REQUEST_FAILED";
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) error = payload.error;
    } catch {
      // ignore
    }
    throw new Error(error);
  }
  return (await response.json()) as T;
}
