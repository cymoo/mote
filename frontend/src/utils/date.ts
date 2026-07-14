/**
 * Formats a date into a string.
 *
 * @param timestamp
 * @param withTime - Indicates whether to include the time part. Defaults to false.
 * @param timeZone
 * @returns - The formatted date string, in the format 'YYYY-MM-DD' or 'YYYY-MM-DD HH:mm:ss'.
 */

export function formatDate(
  timestamp: number | Date = Date.now(),
  withTime = false,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const date = new Date(timestamp)

  // Get the user's default locale (e.g., zh-CN, en-US)
  const userLocale = navigator.languages?.[0] || navigator.language || 'en-US'

  // Format the date using Intl.DateTimeFormat
  const formatter = new Intl.DateTimeFormat(userLocale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  // Retrieve the formatted result from formatToParts
  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value
    }
    return acc
  }, {})

  // Assemble the format yyyy-mm-dd hh:mm:ss
  if (withTime) {
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
  } else {
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

export function getDatesBetween(startDate: Date | string, endDate: Date | string) {
  const dates = []

  for (const date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
    dates.push(new Date(date))
  }

  return dates
}

/**
 * Returns the date of the next Sunday from the specified date.
 * If the given date is already Sunday, returns the date itself.
 */
export function getNextSunday(date: Date | string = new Date()) {
  const nextSunday = new Date(date)
  const dayOfWeek = nextSunday.getDay()

  const daysToAdd = (7 - dayOfWeek) % 7
  nextSunday.setDate(nextSunday.getDate() + daysToAdd)
  return nextSunday
}

/**
 * Returns the date of the previous Monday from the specified date.
 * If the given date is already Monday, returns the date itself.
 */
export function getPreviousMonday(date: Date | string = new Date()) {
  const previousMonday = new Date(date)
  const dayOfWeek = previousMonday.getDay()

  const daysToSubtract = (dayOfWeek + 6) % 7
  previousMonday.setDate(previousMonday.getDate() - daysToSubtract)

  return previousMonday
}

/**
 * Generates a UTC date string in the format `YYYY-MM-DD` from a given date object.
 * If no date is provided, the current date is used.
 */
export function getUTCDateString(date = new Date()) {
  // Get the year (four digits)
  const year = date.getUTCFullYear()
  // Get the month (0-11), add 1 to ensure it is two digits
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  // Get the day (1-31), ensure it is two digits
  const day = String(date.getUTCDate()).padStart(2, '0')

  return `${year.toString()}-${month}-${day}`
}

/**
 * Calculates the timestamp (in milliseconds) for the start of the day (00:00:00) of a given local date string.
 * The input date string must be in the format `YYYY-MM-DD`; otherwise, an error is thrown.
 */
export function getTimestampOfDayStart(localDateString: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDateString)) {
    throw new Error('invalid date format，expect YYYY-MM-DD')
  }
  return new Date(`${localDateString}T00:00:00`).getTime()
}

/**
 * Calculates the timestamp (in milliseconds) for the end of the day (23:59:59.999) of a given local date string.
 * The input date string must be in the format `YYYY-MM-DD`; otherwise, an error is thrown.
 */
export function getTimestampOfDayEnd(localDateString: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDateString)) {
    throw new Error('invalid date format，expect YYYY-MM-DD')
  }
  return new Date(`${localDateString}T23:59:59.999`).getTime()
}

/**
 * Formats a timestamp as a feed day heading, e.g. `7月15日 周三` / `Wed, Jul 15`.
 * Prepends today/yesterday (caller passes the translated words) and appends the
 * year when the date falls outside the current year.
 */
export function formatDayHeading(
  timestamp: number,
  lang: 'zh' | 'en',
  todayText: string,
  yesterdayText: string,
) {
  const date = new Date(timestamp)
  const now = new Date()

  let base: string
  if (lang === 'zh') {
    const weekday = '日一二三四五六'[date.getDay()]
    base = `${String(date.getMonth() + 1)}月${String(date.getDate())}日 周${weekday}`
    if (date.getFullYear() !== now.getFullYear()) {
      base = `${String(date.getFullYear())}年${base}`
    }
  } else {
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    base = `${weekdays[date.getDay()]}, ${months[date.getMonth()]} ${String(date.getDate())}`
    if (date.getFullYear() !== now.getFullYear()) {
      base = `${base}, ${String(date.getFullYear())}`
    }
  }

  const dayString = formatDate(date)
  if (dayString === formatDate(now)) return `${todayText} · ${base}`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayString === formatDate(yesterday)) return `${yesterdayText} · ${base}`
  return base
}
