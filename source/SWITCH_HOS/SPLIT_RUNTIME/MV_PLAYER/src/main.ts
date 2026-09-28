import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.50.0').catch(reportFatal);

