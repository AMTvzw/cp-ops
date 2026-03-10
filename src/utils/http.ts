export const isJsonResponse = (response: Response): boolean => {
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json');
};

export const readJsonSafe = async <T>(response: Response): Promise<T | null> => {
  if (!isJsonResponse(response)) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

export const fetchJsonSafe = async <T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ response: Response; data: T | null }> => {
  const response = await fetch(input, init);
  const data = await readJsonSafe<T>(response);
  return { response, data };
};
