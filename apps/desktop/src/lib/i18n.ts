import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Multica UI reads a few labels from its `ui` namespace. Comma's own copy is inline
// English for now; this instance only supplies those labels.
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: "ui",
  ns: ["ui"],
  interpolation: { escapeValue: false },
  resources: {
    en: {
      ui: {
        attach_file: "Attach file",
        toggle_sidebar: "Toggle sidebar",
        copy_code: "Copy code",
        plain_text: "Plain text",
        error_boundary: {
          title: "Something went wrong",
          description: "This part of Comma hit an error.",
          try_again: "Try again",
        },
      },
    },
  },
});

export default i18n;
