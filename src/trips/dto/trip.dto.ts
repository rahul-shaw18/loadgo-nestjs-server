import { IsArray, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class NotifyNewTripDto {
  @ApiProperty({
    description: 'Unique identifier of the trip to notify drivers about',
    example: 500,
  })
  @IsNumber()
  @IsNotEmpty()
  tripId: number;

  @ApiProperty({
    description: 'Array of driver IDs eligible for this trip',
    example: ['D1', 'D2', 'D3'],
    type: [String],
  })
  @IsArray()
  @IsNotEmpty()
  drivers: (string | number)[];
  
  @ApiPropertyOptional({
    description: 'User ID of the customer who created the trip',
    example: 'U1',
  })
  @IsOptional()
  userId?: string | number;
}

export class TripStatusUpdateDto {
  @ApiProperty({
    description:
      'Trip status code: 1=REQUESTED, 2=ACCEPTED, 3=REVOKED, 4=STARTED, 5=COMPLETED, 6=CANCELLED_BY_USER, 7=CANCELLED_BY_DRIVER, 8=REQUEST_TIMEOUT',
    example: 2,
    enum: [1, 2, 3, 4, 5, 6, 7, 8],
  })
  @IsNumber()
  @IsNotEmpty()
  status: number;

  @ApiProperty({
    description: 'Unique identifier of the trip',
    example: 500,
  })
  @IsNumber()
  @IsNotEmpty()
  tripId: number;

  @ApiPropertyOptional({
    description: 'Driver ID (required for status 2=ACCEPTED)',
    example: 'D1',
  })
  @IsOptional()
  driverId?: string | number;

  @ApiPropertyOptional({
    description: 'User ID (required for status 2=ACCEPTED)',
    example: 'U1',
  })
  @IsOptional()
  userId?: string | number;
}

export class DriverLocationDto {
  @ApiProperty({
    description: 'Trip the driver is currently serving',
    example: 500,
  })
  @IsNumber()
  @IsNotEmpty()
  tripId: number;

  @ApiProperty({ description: 'Latitude in decimal degrees', example: 28.6139 })
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @ApiProperty({ description: 'Longitude in decimal degrees', example: 77.209 })
  @IsNumber()
  @IsNotEmpty()
  longitude: number;

  @ApiPropertyOptional({ description: 'Heading in degrees (0–360)', example: 90 })
  @IsOptional()
  @IsNumber()
  heading?: number;

  @ApiPropertyOptional({ description: 'Speed in km/h', example: 32.5 })
  @IsOptional()
  @IsNumber()
  speed?: number;

  @ApiPropertyOptional({
    description: 'Client timestamp in milliseconds since epoch',
    example: 1718870400000,
  })
  @IsOptional()
  @IsNumber()
  timestamp?: number;
}

export class TripStartedSocketDto {
  @ApiProperty({ description: 'Trip ID', example: 725 })
  @IsNotEmpty()
  tripId: number | string;

  @ApiPropertyOptional({ description: 'Driver ID (resolved from socket if omitted)' })
  @IsOptional()
  driverId?: string | number;

  @ApiPropertyOptional({ description: 'Vehicle number' })
  @IsOptional()
  @IsString()
  vehicleNo?: string;

  @ApiProperty({
    description: 'Driver latitude at trip start',
    example: '22.56730330',
  })
  @IsNotEmpty()
  lat: number | string;

  @ApiProperty({
    description: 'Driver longitude at trip start',
    example: '88.38463000',
  })
  @IsNotEmpty()
  lng: number | string;
}

export class TripCompletedSocketDto {
  @ApiProperty({ description: 'Trip ID', example: 725 })
  @IsNotEmpty()
  tripId: number | string;

  @ApiPropertyOptional({ description: 'Driver ID (resolved from socket if omitted)' })
  @IsOptional()
  driverId?: string | number;

  @ApiPropertyOptional({ description: 'Vehicle number' })
  @IsOptional()
  @IsString()
  vehicleNo?: string;

  @ApiPropertyOptional({ description: 'Driver feedback on trip completion' })
  @IsOptional()
  @IsString()
  driversFeedback?: string;

  @ApiPropertyOptional({ description: 'User rating provided by driver', example: 5 })
  @IsOptional()
  @IsNumber()
  feedbackUsersRating?: number;

  @ApiProperty({
    description: 'Driver latitude at trip completion',
    example: '22.56730330',
  })
  @IsNotEmpty()
  lat: number | string;

  @ApiProperty({
    description: 'Driver longitude at trip completion',
    example: '88.38463000',
  })
  @IsNotEmpty()
  lng: number | string;
}
