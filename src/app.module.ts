import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { TripsModule } from './trips/trips.module';

@Module({
  imports: [TripsModule],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
