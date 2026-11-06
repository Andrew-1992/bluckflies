// Interface language (English or Arabic). The same setting drives the screen
// text, the page direction (RTL for Arabic) and the voice language.

const KEY = 'bluckflies.lang';

export const STRINGS = {
  en: {
    tagline: 'Flights from Juba, by voice or text',
    finePin: 'BluckFlies will never ask for your PIN, password or card number.',
    brandTag: 'AI travel agent',
    footAbout: 'An AI travel companion for flights into, out of and within South Sudan. Search, compare, book and pay in English or Arabic, by voice or text.',
    footBook: 'Book', footHelp: 'Help', footPay: 'Ways to pay', footLangs: 'Languages',
    footPopular: 'Popular places', footDocs: 'Travel documents', footBaggage: 'Baggage', footBaggagePrompt: 'What baggage can I bring on my flight?',
    footPayHow: 'How to pay', footCurrency: 'Prices and payments in US dollars. Bank cards from South Sudanese banks are accepted when enabled for online payments.',
    footCopy: '© {year} BluckFlies · Juba, South Sudan', footLegal: 'Legal', footTerms: 'Terms', footPrivacy: 'Privacy', footRefunds: 'Refunds', footTop: 'Back to top', skip: 'Skip to message box', messageLabel: 'Message BluckFlies', main: 'Main menu',
    navHome: 'Home', navTickets: 'My tickets', navHelp: 'Help', navSpeak: 'Speak',
    langSwitch: 'العربية', langSwitchLabel: 'Change language to Arabic',
    soundOn: 'Sound on', soundOff: 'Sound off',
    chooseLang: 'Choose your language',
    welcome: 'Welcome to BluckFlies. Tap the big microphone and say where you want to fly. Or tap Find a flight.',
    heroQ: 'Where do you want to fly?',
    tapSpeak: 'Tap and speak', orType: 'or type here', typePh: 'Type here…', send: 'Send', listen: 'Listen', stop: 'Stop',
    findFlight: 'Find a flight', findFlightSay: 'Find a flight. Choose a city, a day, and how many people.',
    townsTile: 'Fly inside South Sudan', townsTileSay: 'Fly inside South Sudan: Bor, Wau, Malakal, Rumbek and other towns.',
    compare: 'Compare prices', compareSay: 'Compare prices. See the cheapest and the fastest flights.', comparePrompt: 'Compare the cheapest and fastest flights for my trip.',
    hold: 'Hold seats', holdSay: 'Hold seats. Keep your seats for a short time, then pay.', holdPrompt: 'How do I hold seats and pay later?',
    pay: 'Pay safely', paySay: 'Pay safely with your bank card, or by bank transfer or cash at a bank. Never say your PIN.', payPrompt: 'How can I pay?',
    manage: 'Change or cancel', manageSay: 'Change or cancel a booking, or get your money back.', managePrompt: 'I want to change or cancel my booking.',
    help: 'Travel help', helpSay: 'Travel help. Documents, airports and bags. Or talk to a person.', helpPrompt: 'What documents do I need to travel?',
    talkPerson: 'Talk to a person', talkPersonPrompt: "I'd like to talk to a person, please.",
    popular: 'Popular places', fromJuba: 'From Juba',
    trust1: 'You decide', trust2: 'No PIN in chat', trust3: 'Ticket after payment',
    // guided search
    stepOf: 'Step {n} of 4', back: 'Back', close: 'Close',
    tripType: 'One way or return?', oneWay: 'One way', returnTrip: 'Return', whichReturnDay: 'Which day do you come back?',
    adults: 'Adults', adultsHint: '12 years and over', children: 'Children', childrenHint: '2 to 11 years', babies: 'Babies', babiesHint: 'Under 2 years, on a lap',
    whoAdults: '{n} adult{s}', whoChildren: '{n} child{ren}', whoBabies: '{n} baby{ies} under 2', and: 'and',
    retPart: ' and back on {date} ({iso})',
    going: 'Going', comingBack: 'Coming back',
    loginTitle: 'Keep your tickets on any phone', loginText: 'Log in with your phone number. We send you a code by SMS.',
    phoneLabel: 'Phone number', sendCode: 'Send code', codeLabel: 'Code from the SMS', codeSent: 'We sent a code to {phone}.',
    login: 'Log in', loggedInAs: 'Logged in as {phone}', logout: 'Log out',
    loginNote: 'Never share this code with anyone, including BluckFlies staff.', welcomeBack: 'Welcome back.',
    whereTo: 'Where do you want to go?', fromCity: 'From {city}', change: 'Change', otherPlace: 'Other place? Speak it',
    inSouthSudan: 'South Sudan', abroad: 'Other countries', inSouthSudanHint: 'Towns and cities', abroadHint: 'Nairobi, Dubai, Cairo…', viaRoad: 'Fly to {city}, then by road', townsTitle: 'Towns in South Sudan',
    whichDay: 'Which day do you want to fly?', today: 'Today', tomorrow: 'Tomorrow', otherDay: 'Other day',
    howMany: 'How many people are travelling?', people: 'people', person: 'person', fewer: 'One less', more: 'One more',
    searchNow: 'Find flights',
    guidePrompt: 'Find flights from {from} to {to} on {date} ({iso}){ret} for {who}.',
    // chat
    who: 'BluckFlies AI', thinking: 'BluckFlies is thinking…',
    arrivesNextDay: 'Arrives the next day', arrivesDaysLater: 'Arrives {n} days later',
    netDown: 'No connection. Your message was not sent.', netRetry: 'Send again', netAuto: 'We will send it when you are back online.',
    errGeneric: 'Something went wrong on our side. Please try again.',
    stop: 'Stop', stopped: 'You stopped this reply.', tryAgain: 'Try again',
    netCut: 'The connection dropped while BluckFlies was answering.', recovering: 'Getting the answer…',
    replyFailed: 'The answer did not arrive.',
    newChat: 'New chat', newChatHint: 'Start again and forget this chat on this phone',
    stepWorking: 'Working on it…', stepAirports: 'Finding the airport…',
    stepSearch: 'Searching flights…', stepSearchRoute: 'Searching flights {from} → {to}…',
    stepOffer: 'Checking the fare and baggage…', stepReserve: 'Preparing your booking…',
    stepBooking: 'Looking up your booking…', stepPayment: 'Preparing your payment…',
    stepPayOptions: 'Checking ways to pay…', stepCancel: 'Checking cancellation and refund…',
    stepStatus: 'Checking the flight status…', stepInfo: 'Looking up travel information…',
    stepHandoff: 'Passing you to our team…',
    flightsFound: '{n} flight{s}', seeFlights: 'See all flights',
    q1: 'Only direct flights', q1p: 'Show me only the direct flights.',
    q2: 'Earlier', q2p: 'Are there earlier departures?',
    q3: 'Next day', q3p: 'What about the day after?',
    q4: 'Compare the top two', q4p: 'Compare the top two options for me.',
    // trip panel
    panel: 'Your trip', tFlights: 'Flights', tRoute: 'Route', tBookings: 'Bookings',
    sBest: 'Best', sCheap: 'Cheapest', sFast: 'Fastest', sDirect: 'Direct only',
    emptyFlights: 'Flights you find will show here.', emptyRoute: 'Your route will show here.', emptyBookings: 'No bookings yet.',
    noDirect: 'No direct flights here. Ask BluckFlies to search again.',
    routeOf: 'Route of the best choice', routeFor: 'Route for booking {pnr}',
    // offers
    tagBest: 'Best choice', tagCheap: 'Cheapest', tagFast: 'Fastest',
    direct: 'Direct', stops: '{n} stop{s}', choose: 'Choose', details: 'More details', askAbout: 'Ask about it',
    refundYes: 'Money back if you cancel', refundNo: 'No money back', seatsLeft: '{n} seats left',
    holdLater: 'Hold now, pay later', payFirst: 'Pay to confirm', totalFor: 'Total',
    choosePrompt: "I'd like {airline} {flights}, departing {from} at {time} on {date} (offer {id}).",
    askPrompt: 'Tell me the baggage, fare rules and refund policy for {airline} {flight} (offer {id}).',
    offerSay: '{airline}. Leaves {from} at {dep}. Arrives {to} at {arr}. {stops}. {price} in total.',
    outbound: 'Going', returnLeg: 'Coming back', bothWays: 'Return ticket, both ways',
    returnSay: ' Coming back: leaves {from} on {date} at {dep}, arrives {to} at {arr}. {stops}.',
    chooseReturn: ' and back {flights} on {date}',
    bookingReturnSay: ' Coming back on {date} at {time}.',
    // proposals
    confirmBook: 'Book these seats?', confirmCancel: 'Cancel this booking?', suggested: 'Suggested by AI',
    yes: 'Yes', no: 'No', nothingYet: 'Nothing happens until you press Yes.', wait: 'Please wait…', declined: 'OK. Nothing was booked.',
    confirmedFollow: 'I confirmed. My booking code is {pnr}. How can I pay?', cancelledFollow: 'I confirmed the cancellation of {pnr}.',
    // bookings
    code: 'Booking code', travellers: 'Travellers', total: 'Total', payBefore: 'Pay before', ticketNos: 'Ticket numbers',
    st_held: 'Seats held. Pay now', st_payment_pending: 'Waiting for payment', st_ticketing: 'Paid. Ticket coming',
    st_ticketed: 'Ticket ready', st_expired: 'Time ran out', st_cancelled: 'Cancelled', st_refund_pending: 'Money coming back', st_refunded: 'Money returned',
    payCard: 'Pay with bank card', payMomo: 'Pay with MTN MoMo', payLink: 'Pay by card (secure)',
    payCardPrompt: 'I want to pay for {pnr} by bank card.', payMomoPrompt: 'I want to pay for {pnr} with MTN MoMo.',
    payBank: 'Bank transfer or pay at a bank', payBankPrompt: 'I want to pay for {pnr} by bank transfer or at a bank branch.',
    cardBanks: 'Visa or Mastercard from KCB, Equity, Stanbic, Co-operative, Ivory Bank and other banks. Ask your bank to switch on online payments.',
    bankTitle: 'Pay at the bank', bankName: 'Bank', bankAccountName: 'Account name', bankAccountNo: 'Account number', bankSwift: 'SWIFT',
    bankRef: 'Reference (write exactly)', bankAmount: 'Amount (US dollars)', bankKeep: 'Keep your receipt. We confirm your payment, then send your ticket.',
    bankSay: 'Pay {amount} at {bank}. Account name {name}. Account number {number}. Write your booking code {pnr} as the reference. Pay before the time shown.',
    bankDemo: 'Demo account: do not send real money.', payBankChip: 'Bank transfer',
    childAge: 'Child {n}', yearsOld: 'Age in years',
    searching: 'Looking for flights…', noFlights: 'No flights found for {from} to {to} on that day. Try another day, or tap Help to ask a person.',
    foundFlights: 'Here are the flights. Tap Choose on the one you want.',
    callMeTitle: 'We will call you to book', callMeText: 'Our assistant is not available right now. Leave your name and phone number and a BluckFlies agent will call you to book this flight.',
    callMeName: 'Your name', callMePhone: 'Phone number', callMeSend: 'Call me', callMeDone: 'Thank you. A BluckFlies agent will call {phone} soon to book your flight. Keep your phone on.',
    printTicket: 'Print e-ticket (PDF)', printTicketNote: 'Show it printed or on your phone at check-in, with your passport or ID.',
    payCash: 'Pay cash at an office', payCashPrompt: 'I want to pay for {pnr} in cash at a BluckFlies office.', payCashChip: 'Cash at office',
    cashTitle: 'Pay cash at an office', cashCode: 'Give this booking code', cashKeep: 'Pay in US dollars and always take a numbered receipt. We confirm your payment, then send your ticket.',
    cashSay: 'Pay {amount} in cash at {office}, {address}. Open {hours}. Give your booking code {pnr}. Take a receipt.', cashDemo: 'Demo office: not a real place.',
    payFailed: 'The card payment for {ref} did not go through. Ask your bank to allow online payments, try another card, or pay by bank transfer.',
    demoPay: 'Demo: pretend you approved the payment on your phone.', approve: 'Approve payment', decline: 'Decline',
    bookingSay: 'Booking code {code}. {from} to {to}, {date} at {time}. {status}.',
    // trips view
    ticketsTitle: 'My tickets', ticketsSub: 'Your bookings on this device.', noTickets: 'No tickets yet.', loading: 'Loading…',
    // payment return
    payCancelled: 'Card payment for {ref} was not finished. Your seats stay held for now. You can try again.',
    payChecking: 'Payment sent for {ref}. Checking with the bank…', payDone: 'Payment confirmed. Your ticket is ready.',
    payLate: "We haven't received confirmation for {ref} yet. Check My tickets in a few minutes. You won't pay twice.",
    // voice
    voiceTitle: 'Talk to BluckFlies', viewFlights: 'See flights on screen',
    listening: 'Listening…', speaking: 'Speaking…', tapMic: 'Tap the microphone to talk', paused: 'Paused. Tap the microphone to talk.',
    orbIdle: 'Start talking', orbListening: 'Stop listening', orbThinking: 'Working on it', orbSpeaking: 'Stop speaking',
    voicePrivacy: "Your phone's speech service turns your voice into text. Never say a PIN or card number.",
    noArabicVoice: 'This phone has no Arabic voice, so answers are shown as text. Android: Settings → Text-to-speech → add Arabic.',
    noVoice: 'This device cannot read answers aloud.',
    vErr_notAllowed: 'The microphone is blocked. Allow it in your browser settings.',
    vErr_noMic: 'No microphone found.', vErr_network: 'Voice needs internet. Check your connection.',
    vErr_noSpeech: "I didn't hear you. Tap the microphone and try again.", vErr_lang: 'This browser cannot hear this language. Try the other language.',
    vErr_other: 'Voice stopped. Tap the microphone to try again.',
  },
  ar: {
    tagline: 'رحلات من جوبا، بالصوت أو بالكتابة',
    finePin: 'بلك فلايز لن يطلب منك أبداً رقمك السري أو كلمة المرور أو رقم بطاقتك.',
    brandTag: 'وكيل سفر ذكي',
    footAbout: 'رفيق سفر ذكي لرحلاتك من وإلى وداخل جنوب السودان. ابحث وقارن واحجز وادفع بالعربية أو الإنجليزية، بالصوت أو الكتابة.',
    footBook: 'احجز', footHelp: 'مساعدة', footPay: 'طرق الدفع', footLangs: 'اللغات',
    footPopular: 'أماكن شائعة', footDocs: 'وثائق السفر', footBaggage: 'الحقائب', footBaggagePrompt: 'ما الحقائب المسموح بها في رحلتي؟',
    footPayHow: 'كيف تدفع', footCurrency: 'الأسعار والدفع بالدولار الأمريكي. نقبل البطاقات المصرفية من بنوك جنوب السودان إذا كانت مفعّلة للدفع عبر الإنترنت.',
    footCopy: '© {year} بلك فلايز · جوبا، جنوب السودان', footLegal: 'الشروط', footTerms: 'الشروط والأحكام', footPrivacy: 'الخصوصية', footRefunds: 'الاسترداد', footTop: 'العودة إلى الأعلى', skip: 'انتقل إلى مربع الرسالة', messageLabel: 'راسل بلك فلايز', main: 'القائمة الرئيسية',
    navHome: 'الرئيسية', navTickets: 'تذاكري', navHelp: 'مساعدة', navSpeak: 'تحدّث',
    langSwitch: 'English', langSwitchLabel: 'غيّر اللغة إلى الإنجليزية',
    soundOn: 'الصوت يعمل', soundOff: 'الصوت متوقف',
    chooseLang: 'اختر لغتك',
    welcome: 'مرحباً بك في بلك فلايز. اضغط على الميكروفون الكبير وقل إلى أين تريد السفر. أو اضغط ابحث عن رحلة.',
    heroQ: 'إلى أين تريد السفر؟',
    tapSpeak: 'اضغط وتحدّث', orType: 'أو اكتب هنا', typePh: 'اكتب هنا…', send: 'إرسال', listen: 'استمع', stop: 'إيقاف',
    findFlight: 'ابحث عن رحلة', findFlightSay: 'ابحث عن رحلة. اختر المدينة واليوم وعدد المسافرين.',
    townsTile: 'رحلات داخل جنوب السودان', townsTileSay: 'رحلات داخل جنوب السودان: بور وواو وملكال ورمبيك ومدن أخرى.',
    compare: 'قارن الأسعار', compareSay: 'قارن الأسعار. شاهد أرخص وأسرع الرحلات.', comparePrompt: 'قارن لي بين أرخص وأسرع الرحلات لرحلتي.',
    hold: 'احجز مقاعد', holdSay: 'احجز مقاعد. احتفظ بمقاعدك لوقت قصير ثم ادفع.', holdPrompt: 'كيف أحجز المقاعد وأدفع لاحقاً؟',
    pay: 'ادفع بأمان', paySay: 'ادفع بأمان ببطاقتك المصرفية، أو بتحويل بنكي أو نقداً في البنك. لا تقل رقمك السري أبداً.', payPrompt: 'كيف يمكنني الدفع؟',
    manage: 'تغيير أو إلغاء', manageSay: 'غيّر أو ألغِ حجزك، أو استرد أموالك.', managePrompt: 'أريد تغيير أو إلغاء حجزي.',
    help: 'مساعدة السفر', helpSay: 'مساعدة السفر. الوثائق والمطارات والحقائب. أو تحدّث مع موظف.', helpPrompt: 'ما هي الوثائق التي أحتاجها للسفر؟',
    talkPerson: 'تحدّث مع موظف', talkPersonPrompt: 'أريد التحدث مع موظف من فضلك.',
    popular: 'أماكن شائعة', fromJuba: 'من جوبا',
    trust1: 'أنت تقرر', trust2: 'لا رقم سري في المحادثة', trust3: 'التذكرة بعد الدفع',
    stepOf: 'الخطوة {n} من 4', back: 'رجوع', close: 'إغلاق',
    tripType: 'ذهاب فقط أم ذهاب وعودة؟', oneWay: 'ذهاب فقط', returnTrip: 'ذهاب وعودة', whichReturnDay: 'في أي يوم تعود؟',
    adults: 'بالغون', adultsHint: '12 سنة فأكثر', children: 'أطفال', childrenHint: 'من 2 إلى 11 سنة', babies: 'رضّع', babiesHint: 'أقل من سنتين، في الحضن',
    whoAdults: '{n} بالغ', whoChildren: '{n} طفل', whoBabies: '{n} رضيع أقل من سنتين', and: 'و',
    retPart: ' والعودة يوم {date} ({iso})',
    going: 'الذهاب', comingBack: 'العودة',
    loginTitle: 'احتفظ بتذاكرك على أي هاتف', loginText: 'سجّل الدخول برقم هاتفك. سنرسل لك رمزاً برسالة نصية.',
    phoneLabel: 'رقم الهاتف', sendCode: 'أرسل الرمز', codeLabel: 'الرمز من الرسالة', codeSent: 'أرسلنا رمزاً إلى {phone}.',
    login: 'تسجيل الدخول', loggedInAs: 'مسجّل الدخول بالرقم {phone}', logout: 'تسجيل الخروج',
    loginNote: 'لا تشارك هذا الرمز مع أحد، ولا حتى موظفي بلك فلايز.', welcomeBack: 'مرحباً بعودتك.',
    whereTo: 'إلى أين تريد الذهاب؟', fromCity: 'من {city}', change: 'تغيير', otherPlace: 'مكان آخر؟ قُله بصوتك',
    inSouthSudan: 'جنوب السودان', abroad: 'دول أخرى', inSouthSudanHint: 'مدن وبلدات', abroadHint: 'نيروبي، دبي، القاهرة…', viaRoad: 'طيران إلى {city} ثم بالطريق', townsTitle: 'مدن في جنوب السودان',
    whichDay: 'في أي يوم تريد السفر؟', today: 'اليوم', tomorrow: 'غداً', otherDay: 'يوم آخر',
    howMany: 'كم عدد المسافرين؟', people: 'مسافرين', person: 'مسافر', fewer: 'أقل بواحد', more: 'أكثر بواحد',
    searchNow: 'ابحث عن الرحلات',
    guidePrompt: 'ابحث عن رحلات من {from} إلى {to} يوم {date} ({iso}){ret} لـ {who}.',
    who: 'بلك فلايز', thinking: 'بلك فلايز يفكر…',
    arrivesNextDay: 'يصل في اليوم التالي', arrivesDaysLater: 'يصل بعد {n} أيام',
    netDown: 'لا يوجد اتصال. لم تُرسل رسالتك.', netRetry: 'أرسل مرة أخرى', netAuto: 'سنرسلها عند عودة الاتصال.',
    stop: 'إيقاف', stopped: 'لقد أوقفت هذا الرد.', tryAgain: 'حاول مرة أخرى',
    netCut: 'انقطع الاتصال أثناء رد بلك فلايز.', recovering: 'جارٍ جلب الرد…',
    replyFailed: 'لم يصل الرد.',
    newChat: 'محادثة جديدة', newChatHint: 'ابدأ من جديد وانسَ هذه المحادثة على هذا الهاتف',
    stepWorking: 'جارٍ العمل…', stepAirports: 'جارٍ البحث عن المطار…',
    stepSearch: 'جارٍ البحث عن رحلات…', stepSearchRoute: 'جارٍ البحث عن رحلات {from} ← {to}…',
    stepOffer: 'جارٍ التحقق من السعر والأمتعة…', stepReserve: 'جارٍ تجهيز حجزك…',
    stepBooking: 'جارٍ البحث عن حجزك…', stepPayment: 'جارٍ تجهيز الدفع…',
    stepPayOptions: 'جارٍ التحقق من طرق الدفع…', stepCancel: 'جارٍ التحقق من الإلغاء والاسترداد…',
    stepStatus: 'جارٍ التحقق من حالة الرحلة…', stepInfo: 'جارٍ البحث عن معلومات السفر…',
    stepHandoff: 'جارٍ تحويلك إلى فريقنا…',
    errGeneric: 'حدث خطأ من جهتنا. حاول مرة أخرى من فضلك.',
    flightsFound: '{n} رحلات', seeFlights: 'عرض كل الرحلات',
    q1: 'رحلات مباشرة فقط', q1p: 'أرني الرحلات المباشرة فقط.',
    q2: 'أبكر', q2p: 'هل توجد رحلات أبكر؟',
    q3: 'اليوم التالي', q3p: 'ماذا عن اليوم التالي؟',
    q4: 'قارن أفضل اثنتين', q4p: 'قارن لي بين أفضل خيارين.',
    panel: 'رحلتك', tFlights: 'الرحلات', tRoute: 'المسار', tBookings: 'الحجوزات',
    sBest: 'الأفضل', sCheap: 'الأرخص', sFast: 'الأسرع', sDirect: 'مباشرة فقط',
    emptyFlights: 'ستظهر الرحلات التي تجدها هنا.', emptyRoute: 'سيظهر مسارك هنا.', emptyBookings: 'لا توجد حجوزات بعد.',
    noDirect: 'لا توجد رحلات مباشرة هنا. اطلب من بلك فلايز البحث مرة أخرى.',
    routeOf: 'مسار الخيار الأفضل', routeFor: 'مسار الحجز {pnr}',
    tagBest: 'الخيار الأفضل', tagCheap: 'الأرخص', tagFast: 'الأسرع',
    direct: 'مباشرة', stops: '{n} توقف', choose: 'اختر', details: 'تفاصيل أكثر', askAbout: 'اسأل عنها',
    refundYes: 'يمكن استرداد المال عند الإلغاء', refundNo: 'لا يمكن استرداد المال', seatsLeft: 'بقي {n} مقاعد',
    holdLater: 'احجز الآن وادفع لاحقاً', payFirst: 'ادفع للتأكيد', totalFor: 'المجموع',
    choosePrompt: 'أريد رحلة {airline} {flights} المغادرة من {from} الساعة {time} يوم {date} (offer {id}).',
    askPrompt: 'أخبرني عن الحقائب وشروط التذكرة والاسترداد لرحلة {airline} {flight} (offer {id}).',
    offerSay: '{airline}. تغادر {from} الساعة {dep}. تصل {to} الساعة {arr}. {stops}. المجموع {price}.',
    outbound: 'الذهاب', returnLeg: 'العودة', bothWays: 'تذكرة ذهاب وعودة',
    returnSay: ' العودة: تغادر {from} يوم {date} الساعة {dep}، وتصل {to} الساعة {arr}. {stops}.',
    chooseReturn: ' والعودة {flights} يوم {date}',
    bookingReturnSay: ' العودة يوم {date} الساعة {time}.',
    confirmBook: 'هل تحجز هذه المقاعد؟', confirmCancel: 'هل تلغي هذا الحجز؟', suggested: 'اقتراح من الذكاء الاصطناعي',
    yes: 'نعم', no: 'لا', nothingYet: 'لن يحدث شيء حتى تضغط نعم.', wait: 'يرجى الانتظار…', declined: 'حسناً. لم يتم حجز شيء.',
    confirmedFollow: 'لقد أكدت. رمز حجزي هو {pnr}. كيف أدفع؟', cancelledFollow: 'لقد أكدت إلغاء الحجز {pnr}.',
    code: 'رمز الحجز', travellers: 'المسافرون', total: 'المجموع', payBefore: 'ادفع قبل', ticketNos: 'أرقام التذاكر',
    st_held: 'المقاعد محجوزة. ادفع الآن', st_payment_pending: 'في انتظار الدفع', st_ticketing: 'تم الدفع. التذكرة قادمة',
    st_ticketed: 'التذكرة جاهزة', st_expired: 'انتهى الوقت', st_cancelled: 'ملغى', st_refund_pending: 'المال في طريقه إليك', st_refunded: 'تمت إعادة المال',
    payCard: 'ادفع بالبطاقة المصرفية', payMomo: 'ادفع عبر MTN MoMo', payLink: 'ادفع بالبطاقة (آمن)',
    payCardPrompt: 'أريد أن أدفع للحجز {pnr} بالبطاقة المصرفية.', payMomoPrompt: 'أريد أن أدفع للحجز {pnr} عبر MTN MoMo.',
    payBank: 'تحويل بنكي أو الدفع في البنك', payBankPrompt: 'أريد أن أدفع للحجز {pnr} بتحويل بنكي أو في فرع البنك.',
    cardBanks: 'فيزا أو ماستركارد من KCB وإكويتي وستانبيك والتعاوني وآيفوري وبنوك أخرى. اطلب من بنكك تفعيل الدفع عبر الإنترنت.',
    bankTitle: 'الدفع في البنك', bankName: 'البنك', bankAccountName: 'اسم الحساب', bankAccountNo: 'رقم الحساب', bankSwift: 'سويفت',
    bankRef: 'المرجع (اكتبه كما هو)', bankAmount: 'المبلغ (بالدولار الأمريكي)', bankKeep: 'احتفظ بالإيصال. نؤكد دفعتك ثم نرسل تذكرتك.',
    bankSay: 'ادفع {amount} في {bank}. اسم الحساب {name}. رقم الحساب {number}. اكتب رمز حجزك {pnr} كمرجع. ادفع قبل الوقت المعروض.',
    bankDemo: 'حساب تجريبي: لا ترسل أموالاً حقيقية.', payBankChip: 'تحويل بنكي',
    childAge: 'الطفل {n}', yearsOld: 'العمر بالسنوات',
    searching: 'نبحث عن رحلات…', noFlights: 'لا توجد رحلات من {from} إلى {to} في ذلك اليوم. جرّب يوماً آخر، أو اضغط مساعدة للتحدث مع شخص.',
    foundFlights: 'هذه هي الرحلات. اضغط اختر على الرحلة التي تريدها.',
    callMeTitle: 'سنتصل بك للحجز', callMeText: 'مساعدنا غير متاح الآن. اترك اسمك ورقم هاتفك وسيتصل بك موظف من بلك فلايز لحجز هذه الرحلة.',
    callMeName: 'اسمك', callMePhone: 'رقم الهاتف', callMeSend: 'اتصلوا بي', callMeDone: 'شكراً. سيتصل موظف من بلك فلايز على {phone} قريباً لحجز رحلتك. أبقِ هاتفك مفتوحاً.',
    printTicket: 'اطبع التذكرة (PDF)', printTicketNote: 'أظهرها مطبوعة أو على هاتفك عند تسجيل الوصول، مع جواز السفر أو الهوية.',
    payCash: 'ادفع نقداً في مكتب', payCashPrompt: 'أريد أن أدفع للحجز {pnr} نقداً في مكتب BluckFlies.', payCashChip: 'نقداً في المكتب',
    cashTitle: 'الدفع نقداً في مكتب', cashCode: 'أعطِ رمز الحجز هذا', cashKeep: 'ادفع بالدولار الأمريكي وخذ دائماً إيصالاً مرقّماً. نؤكد دفعتك ثم نرسل تذكرتك.',
    cashSay: 'ادفع {amount} نقداً في {office}، {address}. مفتوح {hours}. أعطِ رمز حجزك {pnr}. خذ إيصالاً.', cashDemo: 'مكتب تجريبي: ليس مكاناً حقيقياً.',
    payFailed: 'لم يتم الدفع بالبطاقة للحجز {ref}. اطلب من بنكك السماح بالدفع عبر الإنترنت، أو جرّب بطاقة أخرى، أو ادفع بتحويل بنكي.',
    demoPay: 'تجربة: تظاهر بأنك وافقت على الدفع من هاتفك.', approve: 'وافق على الدفع', decline: 'رفض',
    bookingSay: 'رمز الحجز {code}. من {from} إلى {to}، {date} الساعة {time}. {status}.',
    ticketsTitle: 'تذاكري', ticketsSub: 'حجوزاتك على هذا الجهاز.', noTickets: 'لا توجد تذاكر بعد.', loading: 'جارٍ التحميل…',
    payCancelled: 'لم يكتمل الدفع بالبطاقة للحجز {ref}. مقاعدك ما زالت محجوزة الآن. يمكنك المحاولة مرة أخرى.',
    payChecking: 'تم إرسال الدفع للحجز {ref}. نتحقق مع البنك…', payDone: 'تم تأكيد الدفع. تذكرتك جاهزة.',
    payLate: 'لم يصلنا تأكيد الحجز {ref} بعد. افتح تذاكري بعد بضع دقائق. لن تدفع مرتين.',
    voiceTitle: 'تحدّث مع بلك فلايز', viewFlights: 'شاهد الرحلات على الشاشة',
    listening: 'أستمع إليك…', speaking: 'أتحدث…', tapMic: 'اضغط على الميكروفون للتحدث', paused: 'متوقف. اضغط على الميكروفون للتحدث.',
    orbIdle: 'ابدأ الحديث', orbListening: 'أوقف الاستماع', orbThinking: 'جارٍ العمل', orbSpeaking: 'أوقف الكلام',
    voicePrivacy: 'خدمة الكلام في هاتفك تحوّل صوتك إلى نص. لا تقل رقمك السري أو رقم بطاقتك أبداً.',
    noArabicVoice: 'لا يوجد صوت عربي في هذا الهاتف، لذلك تظهر الإجابات كنص. أندرويد: الإعدادات ← تحويل النص إلى كلام ← أضف العربية.',
    noVoice: 'هذا الجهاز لا يستطيع قراءة الإجابات بصوت عالٍ.',
    vErr_notAllowed: 'الميكروفون محظور. اسمح به من إعدادات المتصفح.',
    vErr_noMic: 'لم يتم العثور على ميكروفون.', vErr_network: 'الصوت يحتاج إلى إنترنت. تحقق من الاتصال.',
    vErr_noSpeech: 'لم أسمعك. اضغط على الميكروفون وحاول مرة أخرى.', vErr_lang: 'هذا المتصفح لا يفهم هذه اللغة. جرّب اللغة الأخرى.',
    vErr_other: 'توقف الصوت. اضغط على الميكروفون للمحاولة مرة أخرى.',
  },
};

function saved() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'en' || v === 'ar' ? v : null;
  } catch {
    return null;
  }
}

let lang = saved();
const listeners = new Set();

/** The chosen language, or English until the traveller picks one. */
export const getLang = () => lang ?? 'en';
export const hasChosenLang = () => lang !== null;

export function t(key, vars = {}) {
  const s = STRINGS[getLang()][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

export function setLang(next) {
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* per-device convenience */ }
  applyLang();
  listeners.forEach((fn) => fn(next));
}

export function onLangChange(fn) {
  listeners.add(fn);
}

/** Sets page language/direction and fills every element marked with data-t, data-t-aria or data-t-ph. */
export function applyLang(root = document) {
  const l = getLang();
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
  root.querySelectorAll('[data-t]').forEach((n) => { n.textContent = t(n.dataset.t); });
  root.querySelectorAll('[data-t-aria]').forEach((n) => n.setAttribute('aria-label', t(n.dataset.tAria)));
  root.querySelectorAll('[data-t-ph]').forEach((n) => n.setAttribute('placeholder', t(n.dataset.tPh)));
}

/** Localised date: "Fri 6 Nov" / "الجمعة ٦ نوفمبر". `iso` is YYYY-MM-DD or a full ISO timestamp. */
export function formatDay(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString(locale(), { ...opts, timeZone: 'UTC' });
}

/** Route arrow that points in the reading direction ("Juba → Nairobi" / "جوبا ← نيروبي"). */
export const arrow = () => (getLang() === 'ar' ? '←' : '→');

/** Locale for numbers and dates: Arabic text with Western digits, matching prices and times. */
export const locale = () => (getLang() === 'ar' ? 'ar-u-nu-latn' : 'en-GB');
