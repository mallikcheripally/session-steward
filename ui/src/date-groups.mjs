const startOfLocalDay = (timestamp) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date;
};

export function sessionDateGroup(timestamp, now = Date.now()) {
  if (!timestamp) return "Older";
  const today = startOfLocalDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const month = new Date(today.getFullYear(), today.getMonth(), 1);

  if (timestamp >= today.getTime()) return "Today";
  if (timestamp >= yesterday.getTime()) return "Yesterday";
  if (timestamp >= week.getTime()) return "Earlier this week";
  if (timestamp >= month.getTime()) return "Earlier this month";
  return "Older";
}

export function sessionDateGroupForSort(record, sort, now = Date.now()) {
  if (sort === "created") return sessionDateGroup(record.createdAtMs, now);
  if (sort === "updated") return sessionDateGroup(record.updatedAtMs, now);
  return null;
}
