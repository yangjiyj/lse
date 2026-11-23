import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export function usePlatformAppEnabled(): boolean {
  const capabilities = useQuery({
    queryKey: ['model-target-capabilities'],
    queryFn: () => api.modelTargets.capabilities(),
    retry: false,
  });
  return capabilities.data?.platformAppEnabled === true;
}
