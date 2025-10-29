# Use specific version for better stability
FROM node:18

WORKDIR /usr/src/app

COPY . .


RUN npm install --legacy-peer-deps


EXPOSE 3000

CMD ["node", "app.js"]