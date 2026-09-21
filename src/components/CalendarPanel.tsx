/**
 * CalendarPanel — compact month view, GitHub-contributions style: each day cell's
 * background intensity encodes how many articles were saved that day. It is purely
 * a DATE SELECTOR for the home list (no page change): tap a day → onSelectDay.
 *
 * Sober by design: hairlines, one green ramp derived from colors.primary, no badges
 * or counters — intensity IS the volume cue. The grid is a fixed 6×7 so navigating
 * months never shifts the layout.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import {
  addMonths,
  formatDayKey,
  intensityLevel,
  monthGrid,
  monthOfKey,
  monthTitle,
  todayKey,
  type CalendarCell,
} from '../services/calendar';
import { colors, radius, spacing, typography } from '../theme';

// Filled days use a green heat ramp. The selected day owns the darker brand green,
// so it always remains visually distinct even when that day contains arrivals.
const HEAT_BG = [colors.surfaceContainer, '#DDF4EF', '#A9DFD5', '#55B8AA', '#2F9689'] as const;
const HEAT_TEXT = [
  colors.onSurfaceVariant,
  colors.onPrimaryContainer,
  colors.onPrimaryContainer,
  colors.onPrimaryContainer,
  colors.onPrimary,
] as const;

// Monday-first (fr).
const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'] as const;

interface CalendarPanelProps {
  /** Whether the panel is currently expanded — re-anchors the month on open. */
  open: boolean;
  /** Articles saved per day (services/calendar.countByDay). */
  counts: Record<string, number>;
  /** Day key (YYYY-MM-DD) currently scoping the home list. */
  selectedDay: string;
  onSelectDay: (key: string) => void;
}

export function CalendarPanel({ open, counts, selectedDay, onSelectDay }: CalendarPanelProps) {
  const [{ year, month }, setDisplayed] = useState(() => monthOfKey(selectedDay));

  // Each time the panel opens, show the selected day's month (not wherever the
  // user last browsed to).
  useEffect(() => {
    if (open) setDisplayed(monthOfKey(selectedDay));
  }, [open, selectedDay]);

  const cells = useMemo(() => monthGrid(year, month), [year, month]);
  const weeks = useMemo(() => {
    const rows: (CalendarCell | null)[][] = [];
    for (let i = 0; i < 6; i++) rows.push(cells.slice(i * 7, i * 7 + 7));
    return rows;
  }, [cells]);
  const maxCount = useMemo(() => {
    let max = 0;
    for (const n of Object.values(counts)) if (n > max) max = n;
    return max;
  }, [counts]);
  const today = todayKey();
  const currentMonth = monthOfKey(today);
  const canGoNext =
    year < currentMonth.year ||
    (year === currentMonth.year && month < currentMonth.month);

  const title = monthTitle(year, month);

  return (
    <View style={styles.container}>
      {/* Month navigation: fixed edge buttons keep the title perfectly centered. */}
      <View style={styles.header}>
        <Pressable
          onPress={() => setDisplayed(addMonths(year, month, -1))}
          style={styles.navButton}
          accessibilityRole="button"
          accessibilityLabel="Mois précédent"
        >
          <MaterialCommunityIcons name="chevron-left" size={22} color={colors.onSurfaceVariant} />
        </Pressable>
        <Text style={[typography.titleSmall, styles.monthTitle]}>
          {title.charAt(0).toUpperCase() + title.slice(1)}
        </Text>
        <Pressable
          onPress={() => setDisplayed(addMonths(year, month, 1))}
          disabled={!canGoNext}
          style={[styles.navButton, !canGoNext && styles.navButtonDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Mois suivant"
          accessibilityState={{ disabled: !canGoNext }}
        >
          <MaterialCommunityIcons
            name="chevron-right"
            size={22}
            color={canGoNext ? colors.onSurfaceVariant : colors.outlineVariant}
          />
        </Pressable>
      </View>

      {/* Weekday row */}
      <View style={styles.weekRow}>
        {WEEKDAYS.map((d, i) => (
          <View key={i} style={styles.cell}>
            <Text style={[typography.labelSmall, styles.weekdayText]}>{d}</Text>
          </View>
        ))}
      </View>

      {/* 6×7 day grid */}
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.weekRow}>
          {week.map((cell, ci) => {
            if (!cell) return <View key={ci} style={styles.cell} />;
            const count = counts[cell.key] ?? 0;
            const level = intensityLevel(count, maxCount);
            const isSelected = cell.key === selectedDay;
            const isToday = cell.key === today;
            const isFuture = cell.key > today;
            const hasArrivals = count > 0;
            return (
              <Pressable
                key={cell.key}
                onPress={() => onSelectDay(cell.key)}
                disabled={isFuture}
                style={[
                  styles.cell,
                  styles.dayCell,
                  { backgroundColor: HEAT_BG[level] },
                  hasArrivals && styles.filledCell,
                  isToday && styles.todayCell,
                  isSelected && styles.selectedCell,
                  isFuture && styles.futureCell,
                ]}
                accessibilityRole="button"
                accessibilityLabel={
                  count > 0
                    ? `${formatDayKey(cell.key)}, ${count} article${count > 1 ? 's' : ''}`
                    : formatDayKey(cell.key)
                }
                accessibilityState={{ selected: isSelected, disabled: isFuture }}
              >
                <Text
                  style={[
                    typography.bodySmall,
                    { color: HEAT_TEXT[level] },
                    isSelected && styles.selectedDayText,
                    isFuture && styles.futureDayText,
                  ]}
                >
                  {cell.day}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 44,
  },
  monthTitle: {
    color: colors.onSurface,
    textAlign: 'center',
    flex: 1,
  },
  navButton: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButtonDisabled: {
    opacity: 0.55,
  },
  weekRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  cell: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekdayText: {
    color: colors.onSurfaceVariant,
  },
  dayCell: {
    borderRadius: radius.sm,
  },
  // A quiet outline completes the green fill cue without competing with selection.
  filledCell: {
    borderWidth: 1,
    borderColor: '#9BCFC5',
  },
  // Today, unselected: a quiet hairline ring — noticeable, never loud.
  todayCell: {
    borderWidth: 1,
    borderColor: colors.outline,
  },
  // Selection owns the strongest color; filled days stay on the lighter heat ramp.
  selectedCell: {
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  selectedDayText: {
    fontFamily: 'Inter_600SemiBold',
    color: colors.onPrimary,
  },
  futureCell: {
    backgroundColor: '#E8EFEC',
    borderWidth: 1,
    borderColor: '#DFE7E3',
    opacity: 0.72,
  },
  futureDayText: {
    color: colors.outline,
  },
});
