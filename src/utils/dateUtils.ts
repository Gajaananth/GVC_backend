import { toZonedTime, format } from 'date-fns-tz';

export const SL_TIMEZONE = 'Asia/Colombo';

export const getSLTime = (date: Date = new Date()): Date => {
  return toZonedTime(date, SL_TIMEZONE);
};

export const getSLDateString = (date: Date = new Date()): string => {
  return format(toZonedTime(date, SL_TIMEZONE), 'yyyy-MM-dd', { timeZone: SL_TIMEZONE });
};

export const getSLDateTimeString = (date: Date = new Date()): string => {
  return format(toZonedTime(date, SL_TIMEZONE), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: SL_TIMEZONE });
};
