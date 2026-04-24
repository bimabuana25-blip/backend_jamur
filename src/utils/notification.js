const sendNotification = async (userId, title, message) => {
  const appId = process.env.ONESIGNAL_APP_ID;
  const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

  if (!appId || !restApiKey) {
    console.warn("OneSignal credentials missing. Skipping notification.");
    return;
  }

  const payload = {
    app_id: appId,
    include_aliases: {
      external_id: [userId]
    },
    target_channel: "push",
    headings: { en: title },
    contents: { en: message }
  };

  try {
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Key ${restApiKey}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (result.errors) {
      console.error("OneSignal error:", result.errors);
    } else {
      console.log(`Notification sent to ${userId}: ${title}`);
    }
  } catch (error) {
    console.error("Failed to send notification via OneSignal:", error);
  }
};

module.exports = {
  sendNotification
};
