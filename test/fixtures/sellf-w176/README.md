# Recorded producer envelopes

Unmodified W176 sandbox envelopes captured by the producer from the final implementation on 2026-11-06. Secret values were masked by the producer before capture. Each customer locale is `en`; the consumer does not append missing fields.

- `lead.captured.json`: SHA-256 `2c41319733430c68716611cee7ed712b766eb6637695ac696998fd02040af6b6`
- `license.issued.json`: SHA-256 `f4dbbba0bcc6156809654f6eb13b9c7779b193308e68667a29c900f2df776a39`
- `order.cancelled.json`: SHA-256 `70a75180317b057841e74d5dd51999650a732cc18b6d7976a5deaeb0acf10fc9`
- `order.participants_needed.json`: SHA-256 `6415bb39d144ceecb1a7025e32ea1b17e16ccaaebe3f401bda8201f66f6d49be`
- `order.payment_reminder.json`: SHA-256 `d7fd19ca38b7b4dc737e5703489c11d92f3603fbbcab4bf8cf3abea985ec8054`
- `order.placed.json`: SHA-256 `0f205a7e6c91ccb285ba48727a5c4adc1037df4f458c4868bc41b95c237e60aa`
- `purchase.completed.json`: SHA-256 `b72bd67a4e08aa9c25eb25340cab307f33fa192ceb67de39a5e8969fb9005382`
- `refund.issued.json`: SHA-256 `c6694249162bebded2d4003727b1029cfbc604b56bd57bc293f02697b2f03718`

These records are input evidence, not a guarantee of successful delivery. Order transfer data is null in both bank-transfer envelopes; refund has neither PI nor CS. Those three inputs are rejected for the missing template fields. The other five exercise English delivery. No recorded W176 envelopes for waitlist.signup, access.expired or access.granted were supplied in this set. Existing access.granted documentation data without locale exercises the default language.
