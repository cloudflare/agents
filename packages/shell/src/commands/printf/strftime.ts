/**
 * Strftime Formatting Functions
 *
 * Handles date/time formatting for printf's %(...)T directive.
 */

/**
 * Format a timestamp using strftime-like format string.
 */
export function formatStrftime(
  format: string,
  timestamp: number,
  tz?: string
): string {
  const date = new Date(timestamp * 1000);

  // Build result by replacing format directives
  let result = "";
  let i = 0;

  while (i < format.length) {
    if (format[i] === "%" && i + 1 < format.length) {
      const directive = format[i + 1];
      const formatted = formatStrftimeDirective(date, directive, tz);
      if (formatted !== null) {
        result += formatted;
        i += 2;
      } else {
        // Unknown directive, keep as-is
        result += format[i];
        i++;
      }
    } else {
      result += format[i];
      i++;
    }
  }

  return result;
}

/**
 * Get date/time parts in a specific timezone using Intl.DateTimeFormat.
 * Returns an object with year, month, day, hour, minute, second, weekday.
 */
function getDatePartsInTimezone(
  date: Date,
  tz?: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
    timeZone: tz
  };

  try {
    const formatter = new Intl.DateTimeFormat("en-US", options);
    const parts = formatter.formatToParts(date);

    const getValue = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? "";

    // Convert weekday abbreviation to number (0=Sunday, 6=Saturday)
    // Map prevents prototype pollution
    const weekdayMap = new Map<string, number>([
      ["Sun", 0],
      ["Mon", 1],
      ["Tue", 2],
      ["Wed", 3],
      ["Thu", 4],
      ["Fri", 5],
      ["Sat", 6]
    ]);
    const weekdayStr = getValue("weekday");

    return {
      year: Number.parseInt(getValue("year"), 10) || date.getFullYear(),
      month: Number.parseInt(getValue("month"), 10) || date.getMonth() + 1,
      day: Number.parseInt(getValue("day"), 10) || date.getDate(),
      hour: Number.parseInt(getValue("hour"), 10) || date.getHours(),
      minute: Number.parseInt(getValue("minute"), 10) || date.getMinutes(),
      second: Number.parseInt(getValue("second"), 10) || date.getSeconds(),
      weekday: weekdayMap.get(weekdayStr) ?? date.getDay()
    };
  } catch {
    // Fall back to local time if timezone is invalid
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: date.getDay()
    };
  }
}

/**
 * Format a single strftime directive.
 */
function formatStrftimeDirective(
  date: Date,
  directive: string,
  tz?: string
): string | null {
  const parts = getDatePartsInTimezone(date, tz);

  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

  const dayOfYear = getDayOfYearForParts(parts.year, parts.month, parts.day);
  const weekNumber = getWeekNumberForParts(
    parts.year,
    parts.month,
    parts.day,
    parts.weekday,
    0
  ); // Sunday start
  const weekNumberMon = getWeekNumberForParts(
    parts.year,
    parts.month,
    parts.day,
    parts.weekday,
    1
  ); // Monday start

  switch (directive) {
    case "a":
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parts.weekday];
    case "A":
      return [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday"
      ][parts.weekday];
    case "b":
    case "h":
      return [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec"
      ][parts.month - 1];
    case "B":
      return [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December"
      ][parts.month - 1];
    case "c":
      return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parts.weekday]} ${
        [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec"
        ][parts.month - 1]
      } ${String(parts.day).padStart(2, " ")} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} ${parts.year}`;
    case "C":
      return pad(Math.floor(parts.year / 100));
    case "d":
      return pad(parts.day);
    case "D":
      return `${pad(parts.month)}/${pad(parts.day)}/${pad(parts.year % 100)}`;
    case "e":
      return String(parts.day).padStart(2, " ");
    case "F":
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    case "g":
      return pad(getISOWeekYear(parts.year, parts.month, parts.day) % 100);
    case "G":
      return String(getISOWeekYear(parts.year, parts.month, parts.day));
    case "H":
      return pad(parts.hour);
    case "I":
      return pad(parts.hour % 12 || 12);
    case "j":
      return String(dayOfYear).padStart(3, "0");
    case "k":
      return String(parts.hour).padStart(2, " ");
    case "l":
      return String(parts.hour % 12 || 12).padStart(2, " ");
    case "m":
      return pad(parts.month);
    case "M":
      return pad(parts.minute);
    case "n":
      return "\n";
    case "N":
      // Nanoseconds - we don't have sub-second precision
      return "000000000";
    case "p":
      return parts.hour < 12 ? "AM" : "PM";
    case "P":
      return parts.hour < 12 ? "am" : "pm";
    case "r":
      return `${pad(parts.hour % 12 || 12)}:${pad(parts.minute)}:${pad(parts.second)} ${parts.hour < 12 ? "AM" : "PM"}`;
    case "R":
      return `${pad(parts.hour)}:${pad(parts.minute)}`;
    case "s":
      return String(Math.floor(date.getTime() / 1000));
    case "S":
      return pad(parts.second);
    case "t":
      return "\t";
    case "T":
      return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    case "u":
      return String(parts.weekday === 0 ? 7 : parts.weekday);
    case "U":
      return pad(weekNumber);
    case "V":
      return pad(getISOWeekNumberForParts(parts.year, parts.month, parts.day));
    case "w":
      return String(parts.weekday);
    case "W":
      return pad(weekNumberMon);
    case "x":
      return `${pad(parts.month)}/${pad(parts.day)}/${pad(parts.year % 100)}`;
    case "X":
      return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    case "y":
      return pad(parts.year % 100);
    case "Y":
      return String(parts.year);
    case "z":
      return getTimezoneOffset(date, tz);
    case "Z":
      return getTimezoneName(date, tz);
    case "%":
      return "%";
    default:
      return null;
  }
}

/**
 * Get the timezone offset in +/-HHMM format.
 */
function getTimezoneOffset(date: Date, tz?: string): string {
  if (!tz) {
    // Use local timezone
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const hours = Math.floor(Math.abs(offset) / 60);
    const mins = Math.abs(offset) % 60;
    return `${sign}${String(hours).padStart(2, "0")}${String(mins).padStart(2, "0")}`;
  }

  // For named timezone, we need to get the offset at this specific time
  // This is complex because timezones have DST
  try {
    // Get time string with timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset"
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    if (tzPart) {
      // Value is like "GMT-08:00" or "GMT+05:30"
      const match = tzPart.value.match(/GMT([+-])(\d{2}):(\d{2})/);
      if (match) {
        return `${match[1]}${match[2]}${match[3]}`;
      }
      // Check for UTC case
      if (tzPart.value === "GMT" || tzPart.value === "UTC") {
        return "+0000";
      }
    }
  } catch {
    // Fall through to local offset
  }

  // Fallback to local timezone offset
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offset) / 60);
  const mins = Math.abs(offset) % 60;
  return `${sign}${String(hours).padStart(2, "0")}${String(mins).padStart(2, "0")}`;
}

/**
 * Get the timezone name abbreviation.
 */
function getTimezoneName(date: Date, tz?: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short"
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return tzPart?.value ?? "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Calculate day of year (1-366) from date parts.
 */
function getDayOfYearForParts(
  year: number,
  month: number,
  day: number
): number {
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (isLeap) daysInMonth[1] = 29;

  let dayOfYear = day;
  for (let i = 0; i < month - 1; i++) {
    dayOfYear += daysInMonth[i];
  }
  return dayOfYear;
}

/**
 * Calculate week number from date parts.
 */
function getWeekNumberForParts(
  year: number,
  month: number,
  day: number,
  weekday: number,
  startDay: number
): number {
  const dayOfYear = getDayOfYearForParts(year, month, day);
  // Find day of week of Jan 1
  const jan1 = new Date(year, 0, 1);
  const jan1Weekday = jan1.getDay();

  // Adjust for start day
  const adjustedJan1 = (jan1Weekday - startDay + 7) % 7;
  const adjustedWeekday = (weekday - startDay + 7) % 7;

  // Days from start of first week
  const daysIntoYear = dayOfYear - 1 + adjustedJan1;
  const weekNum = Math.floor((daysIntoYear - adjustedWeekday + 7) / 7);

  return weekNum;
}

/**
 * Calculate ISO week number (1-53).
 */
function getISOWeekNumberForParts(
  year: number,
  month: number,
  day: number
): number {
  // Create date in local time at noon to avoid DST issues
  const tempDate = new Date(year, month - 1, day, 12, 0, 0);
  // Get nearest Thursday
  tempDate.setDate(tempDate.getDate() + 3 - ((tempDate.getDay() + 6) % 7));
  // Get first Thursday of year
  const firstThursday = new Date(tempDate.getFullYear(), 0, 4);
  firstThursday.setDate(
    firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7)
  );
  // Calculate week number
  const diff = tempDate.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
}

/**
 * Get the ISO week year (may differ from calendar year at year boundaries).
 */
function getISOWeekYear(year: number, month: number, day: number): number {
  const tempDate = new Date(year, month - 1, day, 12, 0, 0);
  // Get nearest Thursday
  tempDate.setDate(tempDate.getDate() + 3 - ((tempDate.getDay() + 6) % 7));
  return tempDate.getFullYear();
}
