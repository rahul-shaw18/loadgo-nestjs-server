import { IsArray, IsNumber, IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class NotifyNewTripDto {
  @IsNumber()
  @IsNotEmpty()
  tripId: number;

  @IsArray()
  @IsNotEmpty()
  drivers: (string | number)[];
}

export class TripStatusUpdateDto {
  @IsNumber()
  @IsNotEmpty()
  status: number;

  @IsNumber()
  @IsNotEmpty()
  tripId: number;

  @IsOptional()
  driverId?: string | number;

  @IsOptional()
  userId?: string | number;
}
