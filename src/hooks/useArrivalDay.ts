import { useCallback, useEffect, useState } from 'react';

import { todayKey } from '../services/calendar';
import { watchLocalDay } from '../services/localDayClock';

/** Keep historical browsing within a day, return to today when the day changes. */
export function useArrivalDay() {
  const [days, setDays] = useState(() => {
    const today = todayKey();
    return { today, selectedDay: today };
  });
  useEffect(() => watchLocalDay((today) => {
    setDays((previous) => previous.today === today ? previous : { today, selectedDay: today });
  }), []);
  const setSelectedDay = useCallback((selectedDay: string) => {
    setDays((previous) => ({ ...previous, selectedDay }));
  }, []);
  return { ...days, setSelectedDay };
}
