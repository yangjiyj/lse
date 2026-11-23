import { useEffect, useState } from 'react';

/** 输入停下 delay 毫秒后才更新的值：搜索框按它查后端，避免每敲一个字发一次请求。 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
