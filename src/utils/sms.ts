import { logger } from './logger';
import { supabase } from '../config/supabase';

/**
 * Send an SMS via Notify.lk
 */
export const sendSMS = async (to: string, message: string): Promise<boolean> => {
  try {
    // Check if SMS is globally enabled in company_settings
    const { data: settings } = await supabase
      .from('company_settings')
      .select('sms_enabled')
      .limit(1)
      .single();

    if (!settings?.sms_enabled) {
      logger.info('SMS sending is disabled in company settings.');
      return false;
    }

    const userId = process.env.NOTIFY_LK_USER_ID;
    const apiKey = process.env.NOTIFY_LK_API_KEY;
    const senderId = process.env.NOTIFY_LK_SENDER_ID || 'NotifyDEMO';

    if (!userId || !apiKey) {
      logger.warn('Notify.lk credentials missing. Cannot send SMS.');
      return false;
    }

    // Format phone number (Notify.lk expects 94XXXXXXXXX)
    let formattedTo = to.replace(/\D/g, '');
    if (formattedTo.startsWith('0')) {
      formattedTo = '94' + formattedTo.substring(1);
    }
    
    // Using fetch API to call Notify.lk
    const url = new URL('https://app.notify.lk/api/v1/send');
    url.searchParams.append('user_id', userId);
    url.searchParams.append('api_key', apiKey);
    url.searchParams.append('sender_id', senderId);
    url.searchParams.append('to', formattedTo);
    url.searchParams.append('message', message);

    const response = await fetch(url.toString(), {
      method: 'GET'
    });

    const result: any = await response.json();

    if (result.status === 'success') {
      logger.info(`SMS sent successfully to ${formattedTo}`);
      return true;
    } else {
      logger.error('Failed to send SMS:', result);
      return false;
    }
  } catch (error) {
    logger.error('Error sending SMS:', error);
    return false;
  }
};
