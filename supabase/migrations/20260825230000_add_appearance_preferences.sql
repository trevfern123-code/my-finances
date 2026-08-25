alter table public.user_preferences
  add column theme text not null default 'system',
  add column accent_color text not null default 'green';

alter table public.user_preferences
  add constraint user_preferences_theme_check
    check (theme in ('system', 'light', 'dark'));

alter table public.user_preferences
  add constraint user_preferences_accent_color_check
    check (accent_color in ('green', 'blue', 'teal', 'indigo', 'purple', 'amber'));
