# AMQP dependency notices

`amqp/inventory.json` records the exact locked versions, upstream source links and SHA-256 of complete license/notice texts extracted from their installed wheels. The wheel files and hashes are locked in `server/uv.lock`; runtime, dev and build requirements participate in `make audit`. No advisory exceptions were added.

- aio-pika 10.1.1 and aiormq 7.2.2: Apache-2.0.
- pamqp 4.0.1: BSD-3-Clause.
- multidict 7.1.0: Apache-2.0.
- yarl 1.25.1 and propcache 0.5.4: upstream Apache-2.0 LICENSE and NOTICE, retained byte-for-byte.

These supplemental notices ship in the service wheel/source archive and image. Existing dependencies retain their installed distribution notices. The separately pinned RabbitMQ image retains its MPL-2.0 terms and [upstream source](https://github.com/rabbitmq/rabbitmq-server/tree/v4.3.6); keep the image and its notices when deploying. Neither broker nor Python AMQP packages belong in the practice-app distribution.

## Optional checkout dependencies

`payments/inventory.json` records the pinned official Alipay Python SDK 3.7.1411 and its RSA 4.9.1 / pyasn1 0.6.4 dependency license texts, extracted byte-for-byte from installed locked distributions with SHA-256 hashes and upstream source links. The SDK and RSA retain Apache-2.0; pyasn1 retains BSD-2-Clause. These notices ship in service archives/images and never in the offline App. The SDK is used only by the separately deployed checkout.
