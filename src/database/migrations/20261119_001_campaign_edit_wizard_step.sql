-- Add the dedicated campaign field-edit wizard step without removing any existing workflow step.
ALTER TABLE admin_wizards
  MODIFY COLUMN step ENUM(
    'select_type','title','description','poster','prize_title','prize_description',
    'prize_value','starts_at','ends_at','draw_at','terms','capacity','codes',
    'price','payment_methods','confirm','payment_settings','payment_reject',
    'draw_publication_reference','draw_publication_confirm','campaign_edit_value'
  ) NOT NULL;
