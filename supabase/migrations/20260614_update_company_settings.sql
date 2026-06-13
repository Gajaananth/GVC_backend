-- Update company settings with correct GVC details
UPDATE public.company_settings SET
  company_name = 'GVC',
  company_address = 'SCHOOL ROAD, THANGAVELAYUTHAPURAM, AMPARA, THIRUKKOVIL, AMPARA, EASTERN PROVINCE, SRI LANKA, 32500',
  company_phone = '+94754317396',
  company_email = 'info@gvcagro.lk',
  currency_symbol = '₨'
WHERE TRUE;
