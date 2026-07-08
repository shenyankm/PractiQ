type NavigateOptions = { navigate: (path: string) => void };

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return payload.data as T;
}

export async function createBankFlow(input: { name: string; description: string; subject: string; isPublic: boolean }, { navigate }: NavigateOptions) {
  const result = await postJSON<{ bank: { id: number } }>('/api/v1/banks', input);
  navigate(`/banks/${result.bank.id}`);
}

export async function toggleBankFavoriteFlow({ bankId, nextFavorite }: { bankId: number; nextFavorite: boolean }) {
  await fetch(`/api/v1/banks/${bankId}/favorite`, {
    method: nextFavorite ? 'POST' : 'DELETE',
    credentials: 'include'
  });
}

export async function startPracticeFlow(input: { bankId: number; sessionType: string; questionCount: number; mode: string; questionTypeId: string | null; allQuestions: boolean }, { navigate }: NavigateOptions) {
  const result = await postJSON<{ id: number }>('/api/v1/practice-sessions', input);
  navigate(`/practice/${result.id}`);
}
